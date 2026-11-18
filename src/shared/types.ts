/** Modelo de dominio compartido entre el servidor y la interfaz. */

export const RESULTS = ['passed', 'failed', 'blocked', 'progress'] as const;
export type Result = (typeof RESULTS)[number];

export interface TestType {
  id: string;
  name: string;
  /** Suite grande (Smoke, Regression…): se destaca en el dashboard. */
  major: boolean;
  color: string;
}

export interface TestRunInput {
  /** Fecha local en formato YYYY-MM-DD. */
  date: string;
  typeId: string;
  title: string;
  ticket: string;
  env: string;
  result: Result;
  passed: number | null;
  failed: number | null;
  blocked: number | null;
  bugs: number | null;
  minutes: number | null;
  notes: string;
}

export interface TestRun extends TestRunInput {
  id: string;
  createdAt: number;
}

export interface Settings {
  types: TestType[];
  envs: string[];
  /** URL a la que se añade la clave del ticket para enlazarlo. */
  ticketBase: string;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  type: string;
}

/** Estado de Jira visible para la interfaz: nunca incluye el token. */
export interface JiraState {
  site: string;
  email: string;
  /** Link del board de Jira; si está, los tickets salen de ese board. */
  board: string;
  jql: string;
  hasToken: boolean;
  tickets: JiraTicket[];
  fetchedAt: number | null;
  /**
   * none: falta sitio, email o token · pending: configurado pero aún sin probar ·
   * connected: la última consulta funcionó · error: la última consulta falló (ver `error`).
   */
  connection: JiraConnection;
  error: string | null;
}

export type JiraConnection = 'none' | 'pending' | 'connected' | 'error';

export interface JiraConfigInput {
  site: string;
  email: string;
  board: string;
  jql: string;
  /** Vacío u omitido = conservar el token guardado. */
  token?: string;
}

export interface AppState {
  settings: Settings;
  runs: TestRun[];
  jira: JiraState;
}

export interface Backup extends Settings {
  runs: TestRun[];
}
