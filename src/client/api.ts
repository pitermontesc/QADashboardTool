import type {
  ActivityItem, AppState, AssistantReply, AssistantTurn, Automation, Backup, BackupList, JiraConfigInput, JiraState, Lang, QueueItem, ReportBugEdit, Settings, TestRun, TestRunInput,
} from '../shared/types';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Every change is sent as JSON, even a DELETE with no body: the server refuses other content types.
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      document.documentElement.lang === 'en'
        ? 'Could not reach the local app (is it still open?)'
        : 'No se pudo conectar con la app local (¿sigue abierta?)',
    );
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Error ${response.status}`);
  return payload as T;
}

/** Answer to a launch: the run, or its place in its site's queue if the site was busy. */
export type LaunchResult = Automation | { queued: QueueItem; position: number };
// `position` is only in the queued answer (an Automation has a `queued` field of its own).
export const isQueued = (result: LaunchResult): result is { queued: QueueItem; position: number } => 'position' in result;

export const api = {
  getState: () => request<AppState>('GET', '/api/state'),
  createRun: (input: TestRunInput) => request<TestRun>('POST', '/api/runs', input),
  updateRun: (id: string, input: TestRunInput) => request<TestRun>('PUT', `/api/runs/${encodeURIComponent(id)}`, input),
  deleteRun: (id: string) => request<void>('DELETE', `/api/runs/${encodeURIComponent(id)}`),
  saveSettings: (settings: Settings) => request<Settings>('PUT', '/api/settings', settings),
  importBackup: (backup: Backup) => request<AppState>('POST', '/api/import', backup),
  listBackups: () => request<BackupList>('GET', '/api/backups'),
  backupNow: () => request<BackupList>('POST', '/api/backups', {}),
  restoreBackup: (name: string) => request<AppState>('POST', `/api/backups/${encodeURIComponent(name)}/restore`, {}),
  getLog: () => request<{ file: string; lines: string[] }>('GET', '/api/log'),
  saveJiraConfig: (config: JiraConfigInput) => request<JiraState>('PUT', '/api/jira/config', config),
  runOrchestrator: (key: string, fullCoverage = false) =>
    request<LaunchResult>('POST', `/api/orchestrator/${encodeURIComponent(key)}`, fullCoverage ? { fullCoverage } : {}),
  runRegression: (run: string, dryRun = false) => request<LaunchResult>('POST', '/api/regression', { run, dryRun }),
  runSmoke: (site: string) => request<LaunchResult>('POST', '/api/smoke', { site }),
  queueTickets: (keys: string[]) => request<AppState>('POST', '/api/queue', { keys }),
  removeQueued: (id: string) => request<AppState>('DELETE', `/api/queue/${encodeURIComponent(id)}`),
  moveQueued: (id: string, direction: 'up' | 'down') => request<AppState>('POST', `/api/queue/${encodeURIComponent(id)}/move`, { direction }),
  resumeLane: (site: string) => request<AppState>('POST', '/api/queue/resume', { site }),
  getActivity: (id: string) => request<{ items: ActivityItem[]; logFile: string }>('GET', `/api/automation/${encodeURIComponent(id)}/activity`),
  translateAutomation: (id: string, lang: Lang) => request<Automation>('POST', `/api/automation/${encodeURIComponent(id)}/translate`, { lang }),
  postJiraComment: (id: string, body: string) => request<Automation>('POST', `/api/automation/${encodeURIComponent(id)}/jira-comment`, { body }),
  dismissJiraComment: (id: string, dismissed: boolean) =>
    request<Automation>('POST', `/api/automation/${encodeURIComponent(id)}/jira-comment/dismiss`, { dismissed }),
  updateReportBugs: (id: string, lang: Lang, bugs: ReportBugEdit[]) =>
    request<Automation>('PUT', `/api/automation/${encodeURIComponent(id)}/bugs`, { lang, bugs }),
  askAssistant: (messages: AssistantTurn[]) => request<AssistantReply>('POST', '/api/assistant', { messages }),
  stopAutomation: (id: string) => request<Automation>('POST', `/api/automation/${encodeURIComponent(id)}/stop`, {}),
  deleteAutomation: (id: string) => request<void>('DELETE', `/api/automation/${encodeURIComponent(id)}`),
  refreshJira: () => request<JiraState>('POST', '/api/jira/refresh', {}),
};
