import { DEFAULT_JQL } from '../shared/defaults.js';
import type { JiraTicket } from '../shared/types.js';
import { HttpError } from './errors.js';
import type { JiraCredentials } from './store.js';

interface JiraSearchResponse {
  issues?: Array<{
    key?: string;
    fields?: {
      summary?: string | null;
      status?: { name?: string } | null;
      issuetype?: { name?: string } | null;
    };
  }>;
  errorMessages?: string[];
}

const TIMEOUT_MS = 25_000;
const MAX_TICKETS = 100;

/** Busca tickets con la API REST de Jira Cloud (búsqueda JQL) usando email + API token. */
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

  const url = new URL(`${creds.site.replace(/\/+$/, '')}/rest/api/3/search/jql`);
  url.search = new URLSearchParams({
    jql: creds.jql || DEFAULT_JQL,
    fields: 'summary,status,issuetype',
    maxResults: String(MAX_TICKETS),
  }).toString();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con Jira (revisa el sitio y tu conexión)');
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(502, 'Jira rechazó las credenciales (revisa email y API token)');
  }
  const body = (await response.json().catch(() => ({}))) as JiraSearchResponse;
  if (!response.ok) {
    const detail = body.errorMessages?.join('; ');
    throw new HttpError(502, `Jira respondió ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  return (body.issues ?? []).map((issue) => ({
    key: issue.key ?? '',
    summary: issue.fields?.summary ?? '',
    status: issue.fields?.status?.name ?? '',
    type: issue.fields?.issuetype?.name ?? '',
  }));
}
