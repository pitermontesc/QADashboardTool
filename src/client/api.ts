import type {
  AppState, Backup, JiraConfigInput, JiraState, Settings, TestRun, TestRunInput,
} from '../shared/types';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('No se pudo conectar con la app local (¿sigue abierta la terminal?)');
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Error ${response.status}`);
  return payload as T;
}

export const api = {
  getState: () => request<AppState>('GET', '/api/state'),
  createRun: (input: TestRunInput) => request<TestRun>('POST', '/api/runs', input),
  updateRun: (id: string, input: TestRunInput) => request<TestRun>('PUT', `/api/runs/${encodeURIComponent(id)}`, input),
  deleteRun: (id: string) => request<void>('DELETE', `/api/runs/${encodeURIComponent(id)}`),
  saveSettings: (settings: Settings) => request<Settings>('PUT', '/api/settings', settings),
  importBackup: (backup: Backup) => request<AppState>('POST', '/api/import', backup),
  saveJiraConfig: (config: JiraConfigInput) => request<JiraState>('PUT', '/api/jira/config', config),
  runOrchestrator: (key: string) => request<{ key: string }>('POST', `/api/orchestrator/${encodeURIComponent(key)}`, {}),
  refreshJira: () => request<JiraState>('POST', '/api/jira/refresh', {}),
};
