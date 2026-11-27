import { DEFAULT_JQL } from '../shared/defaults.js';
import { parseJiraBoardUrl, type JiraBoardRef } from '../shared/jiraBoard.js';
import type { JiraTicket, QaPerson } from '../shared/types.js';
import { HttpError } from './errors.js';
import type { JiraCredentials } from './store.js';
import { markdownToJira } from './jiraMarkup.js';

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string | null;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    created?: string | null;
    parent?: { key?: string } | null;
    issuelinks?: Array<{ type?: { name?: string; inward?: string }; inwardIssue?: { key?: string } }> | null;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  total?: number;
  errorMessages?: string[];
}

const TIMEOUT_MS = 25_000;
const MAX_TICKETS = 100;
const FIELDS = 'summary,status,issuetype,priority,created,parent,issuelinks';

/** JQL to fetch a board's tickets: its quick filter + the extra JQL, excluding finished ones. */
export function boardJql(board: JiraBoardRef, extraJql: string): string {
  const extra = extraJql.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '').trim();
  return [board.filter, extra, 'statusCategory != Done']
    .filter((part) => part !== '')
    .map((part) => `(${part})`)
    .join(' AND ');
}

/**
 * Fetches tickets with the Jira Cloud REST API using email + API token: a board's
 * tickets (Agile API) if there is a board link, or a JQL search otherwise.
 */
export async function fetchJiraTickets(
  creds: JiraCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraTicket[]> {
  if (!/^https?:\/\//i.test(creds.site)) {
    throw new HttpError(400, 'Set up the Jira site (https://your-site.atlassian.net)');
  }
  if (!creds.email || !creds.token) {
    throw new HttpError(400, 'The Jira email or API token is missing');
  }

  const site = creds.site.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  const get = (path: string, params: Record<string, string>) =>
    request(fetchImpl, `${site}${path}?${new URLSearchParams(params).toString()}`, auth);

  const board = creds.board ? parseJiraBoardUrl(creds.board) : null;
  if (!board) {
    const body = await get('/rest/api/3/search/jql', {
      jql: creds.jql || DEFAULT_JQL,
      fields: FIELDS,
      maxResults: String(MAX_TICKETS),
    });
    return (body.issues ?? []).map(toTicket);
  }

  // The Agile API pages 50 at most.
  const issues: JiraIssue[] = [];
  const jql = boardJql(board, creds.jql);
  for (;;) {
    const body = await get(`/rest/agile/1.0/board/${board.boardId}/issue`, {
      jql,
      fields: FIELDS,
      startAt: String(issues.length),
      maxResults: String(MAX_TICKETS - issues.length),
    });
    const page = body.issues ?? [];
    issues.push(...page);
    if (page.length === 0 || issues.length >= MAX_TICKETS || issues.length >= (body.total ?? 0)) break;
  }
  return issues.map(toTicket);
}

async function request<T extends { errorMessages?: string[] } = JiraSearchResponse>(
  fetchImpl: typeof fetch,
  url: string,
  auth: string,
  notFound = 'Jira could not find the board (check the link and that you have access)',
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Could not connect to Jira (check the site and your connection)');
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, 'Jira rejected the credentials (check the email and API token)');
  }
  const body = (await response.json().catch(() => ({}))) as T;
  if (response.status === 404) throw new HttpError(502, notFound);
  if (!response.ok) {
    const detail = body.errorMessages?.join('; ');
    throw new HttpError(502, `Jira responded ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

const toTicket = (issue: JiraIssue): JiraTicket => ({
  key: issue.key ?? '',
  summary: issue.fields?.summary ?? '',
  status: issue.fields?.status?.name ?? '',
  type: issue.fields?.issuetype?.name ?? '',
  priority: issue.fields?.priority?.name ?? '',
  created: toTime(issue.fields?.created),
  epic: issue.fields?.parent?.key ?? '',
  // A link with an inward issue on a "Blocks" type means this ticket "is blocked by" that one.
  blockedBy: (issue.fields?.issuelinks ?? [])
    .filter((l) => l.inwardIssue?.key && (l.type?.name === 'Blocks' || /blocked by/i.test(l.type?.inward ?? '')))
    .map((l) => l.inwardIssue!.key!),
});

/** Jira date ("2026-11-20T10:31:00.000-0500") in ms; null if missing or unreadable. */
function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  // Jira writes the offset without a colon (-0500), which some engines do not parse.
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(time) ? null : time;
}

/**
 * Posts a comment on a ticket with the REST API v2 (accepts wiki markup) and returns
 * the link to the comment. Uses the same email + API token as the ticket list.
 */
export async function postJiraComment(
  creds: JiraCredentials,
  key: string,
  markdown: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!/^https?:\/\//i.test(creds.site) || !creds.email || !creds.token) {
    throw new HttpError(400, 'Set up Jira (site, email and API token) in Types & settings to post comments');
  }
  const site = creds.site.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  let response: Response;
  try {
    response = await fetchImpl(`${site}/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: markdownToJira(markdown) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Could not connect to Jira (check the site and your connection)');
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, 'Jira rejected the credentials (check the email and API token)');
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string; errorMessages?: string[]; errors?: Record<string, string> };
  if (response.status === 404) throw new HttpError(502, `Jira did not find ticket ${key} (or you have no access)`);
  if (!response.ok) {
    const detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join('; ');
    throw new HttpError(502, `Jira responded ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return `${site}/browse/${encodeURIComponent(key)}${body.id ? `?focusedCommentId=${body.id}` : ''}`;
}

/** Site and Basic auth for the saved connection; refuses if it is incomplete. */
function connection(creds: JiraCredentials): { site: string; auth: string } {
  if (!/^https?:\/\//i.test(creds.site) || !creds.email || !creds.token) {
    throw new HttpError(400, 'Connect Jira (site, email and API token) in Types & settings first');
  }
  return { site: creds.site.replace(/\/+$/, ''), auth: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}` };
}

interface JiraUser {
  accountId?: string;
  displayName?: string;
  accountType?: string;
  active?: boolean;
  errorMessages?: string[];
}

/** The person the API token belongs to: their name and accountId, for the QA profile. */
export async function fetchJiraMyself(creds: JiraCredentials, fetchImpl: typeof fetch = fetch): Promise<QaPerson> {
  const { site, auth } = connection(creds);
  const me = await request<JiraUser>(fetchImpl, `${site}/rest/api/3/myself`, auth, 'Jira did not find your user');
  if (!me.accountId) throw new HttpError(502, 'Jira did not return your accountId');
  return { name: me.displayName?.trim() || creds.email, accountId: me.accountId };
}

/** People whose name or email matches, for the TC executor: active Atlassian accounts only (no apps or bots). */
export async function searchJiraUsers(creds: JiraCredentials, query: string, fetchImpl: typeof fetch = fetch): Promise<QaPerson[]> {
  const { site, auth } = connection(creds);
  const params = new URLSearchParams({ query, maxResults: '10' });
  const users = await request<JiraUser[] & { errorMessages?: string[] }>(fetchImpl, `${site}/rest/api/3/user/search?${params.toString()}`, auth, 'Jira did not find users');
  return (Array.isArray(users) ? users : [])
    .filter((u) => u.accountId && u.accountType === 'atlassian' && u.active !== false)
    .map((u) => ({ name: u.displayName?.trim() || u.accountId!, accountId: u.accountId! }));
}
