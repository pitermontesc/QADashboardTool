/** Modelo de dominio compartido entre el servidor y la interfaz. */

/** Idiomas de la interfaz. */
export const LANGUAGES = ['es', 'en'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** Tema de la interfaz: `system` sigue el modo claro u oscuro del sistema. */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

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
  /** Idioma de la interfaz y de los reportes de Claude. */
  language: Lang;
  theme: Theme;
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

export type AutomationKind = 'smoke' | 'regression' | 'orchestrator';
/** GO / NO-GO para smoke y regresión; PASSED… / BLOCKED para el orquestador de un ticket. */
export const VERDICTS = ['GO', 'NO-GO', 'PASSED', 'PASSED W/F', 'FAILED', 'BLOCKED'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STEP_STATUSES = ['passed', 'failed', 'blocked', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface ReportStep {
  name: string;
  status: StepStatus;
  notes: string;
}

/** Área probada (Login, Work Orders…) con sus pasos. */
export interface ReportModule {
  name: string;
  status: StepStatus;
  minutes: number | null;
  notes: string;
  steps: ReportStep[];
}

export interface ReportBug {
  title: string;
  severity: string;
  /** Clave del bug en Jira, si se creó. */
  key: string;
  link: string;
  module: string;
}

/** Comentario de QA para Jira que Claude deja listo; la app lo publica con un clic si Claude no pudo. */
export interface JiraComment {
  /** Ticket donde va el comentario (p. ej. AVM-6926). */
  key: string;
  /** Texto en Markdown, tal como lo redactó el skill. */
  body: string;
  posted: boolean;
  /** Link al comentario publicado desde la app. */
  url: string;
  /** Descartado desde la app (por ejemplo, porque ya se publicó otro comentario a mano): no se publica. */
  dismissed: boolean;
}

/** Reporte QA detallado que Claude envía al terminar: módulos, pasos y bugs. */
export interface AutomationDetails {
  /** Versión o build probado, si se ve en el sitio. */
  build: string;
  modules: ReportModule[];
  bugs: ReportBug[];
  /** Observaciones, riesgos o lo que quedó sin probar. */
  notes: string;
  jiraComment: JiraComment | null;
}

/** Resumen y reporte traducidos a otro idioma (el comentario de Jira no se traduce). */
export interface ReportTranslation {
  summary: string;
  details: AutomationDetails | null;
}

/** Ejecución lanzada con Claude Code desde la app (smoke, regresión u orquestador); Claude reporta el resultado al terminar. */
export interface Automation {
  id: string;
  kind: AutomationKind;
  /** Qué se prueba: «QA», «STG», el test run de testomat.io o la clave del ticket. */
  target: string;
  /** Título del registro, sin el veredicto. */
  title: string;
  env: string;
  startedAt: number;
  finishedAt: number | null;
  verdict: Verdict | null;
  summary: string;
  link: string;
  /** Reporte detallado; null si Claude solo envió el resumen. */
  details: AutomationDetails | null;
  /** Registro que la refleja: «En progreso» al lanzarla y con el veredicto al terminar. */
  runId: string | null;
  /** Proceso de Claude Code en segundo plano mientras corre (para detenerlo). */
  pid: number | null;
  /** Log de la ejecución (stream-json de Claude Code). */
  logFile: string;
  /** Idioma en que Claude escribió el resumen y el reporte. */
  lang: Lang;
  /** Traducciones del resumen y el reporte, hechas al ver la app en otro idioma. */
  translations: Partial<Record<Lang, ReportTranslation>>;
}

/** Paso de lo que va haciendo Claude, leído de su log. */
export interface ActivityItem {
  kind: 'start' | 'text' | 'tool' | 'result' | 'error';
  text: string;
}

export interface AppState {
  settings: Settings;
  runs: TestRun[];
  jira: JiraState;
  automations: Automation[];
  /** Reportes que se están traduciendo al idioma de la app. */
  translating: number;
  /** Modo demo: datos de ejemplo y Jira/Claude simulados. */
  demo: boolean;
}

export interface Backup extends Settings {
  runs: TestRun[];
}
