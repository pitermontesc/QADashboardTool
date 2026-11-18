import { DEFAULT_JQL } from '../shared/defaults.js';
import { parseJiraBoardUrl, type JiraBoardRef } from '../shared/jiraBoard.js';
import type { JiraTicket } from '../shared/types.js';
import { HttpError } from './errors.js';
import type { JiraCredentials } from './store.js';

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string | null;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  total?: number;
  errorMessages?: string[];
}

const TIMEOUT_MS = 25_000;
const MAX_TICKETS = 100;
const FIELDS = 'summary,status,issuetype';

/** JQL para pedir los tickets de un board: su filtro rápido + el JQL adicional, sin los ya terminados. */
export function boardJql(board: JiraBoardRef, extraJql: string): string {
  const extra = extraJql.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '').trim();
  return [board.filter, extra, 'statusCategory != Done']
    .filter((part) => part !== '')
    .map((part) => `(${part})`)
    .join(' AND ');
}

/**
 * Busca tickets con la API REST de Jira Cloud usando email + API token: los de
 * un board (API Agile) si hay link de board, o una búsqueda JQL si no.
 */
export async function fetchJiraTickets(
  creds: JiraCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraTicket[]> {
  if (!/^https?:\/\//i.test(creds.site)) {
    throw new HttpError(400, 'Configura el sitio de Jira (https://tu-sitio.atlassian.net)');
  }
  if (!creds.email || !creds.token) {
    throw new HttpError(400, 'Falta el email o el API token de Jira');
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

  // La API Agile pagina de a 50 como máximo.
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

async function request(fetchImpl: typeof fetch, url: string, auth: string): Promise<JiraSearchResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con Jira (revisa el sitio y tu conexión)');
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, 'Jira rechazó las credenciales (revisa email y API token)');
  }
  const body = (await response.json().catch(() => ({}))) as JiraSearchResponse;
  if (response.status === 404) {
    throw new HttpError(502, 'Jira no encontró el board (revisa el link y que tengas acceso)');
  }
  if (!response.ok) {
    const detail = body.errorMessages?.join('; ');
    throw new HttpError(502, `Jira respondió ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

const toTicket = (issue: JiraIssue): JiraTicket => ({
  key: issue.key ?? '',
  summary: issue.fields?.summary ?? '',
  status: issue.fields?.status?.name ?? '',
  type: issue.fields?.issuetype?.name ?? '',
});
