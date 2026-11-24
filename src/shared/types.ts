/** Domain model shared by the server and the UI. */

/** UI languages. */
export const LANGUAGES = ['es', 'en'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** UI theme: `system` follows the OS light or dark mode. */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const RESULTS = ['passed', 'failed', 'blocked', 'progress'] as const;
export type Result = (typeof RESULTS)[number];

export interface TestType {
  id: string;
  name: string;
  /** Major suite (Smoke, Regression…): highlighted on the dashboard. */
  major: boolean;
  color: string;
}

export interface TestRunInput {
  /** Local date in YYYY-MM-DD format. */
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

/** Site under test (QA, STG…): the smoke test runs there, and tickets in its Jira status are validated there. */
export interface QaSite {
  /** Short, stable identifier (qa, stg…); used by the API and the buttons. */
  id: string;
  name: string;
  url: string;
  /** Environment of the test runs recorded for this site. */
  env: string;
  /** Jira status of the tickets tested on this site (On QA…); empty if none. */
  jiraStatus: string;
}

/** Sites, Claude Code skills and test run domains: all configurable in the settings. */
export interface QaConfig {
  sites: QaSite[];
  /** Site the regression runs against. */
  regressionSiteId: string;
  skills: { orchestrator: string; smoke: string; regression: string };
  /** Domains accepted in test run links (testomat.io…). */
  testRunHosts: string[];
}

export interface Settings {
  types: TestType[];
  envs: string[];
  /** URL the ticket key is appended to in order to link it. */
  ticketBase: string;
  /** Language of the UI and of Claude's reports. */
  language: Lang;
  theme: Theme;
  qa: QaConfig;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  type: string;
  /** Jira priority name (Highest, High, Medium…); empty if Jira did not send one. */
  priority: string;
  /** When the ticket was created (ms); null if unknown (tickets cached before v1.15.0). */
  created: number | null;
}

/** Jira state visible to the UI: never includes the token. */
export interface JiraState {
  site: string;
  email: string;
  /** Jira board link; when set, tickets come from that board. */
  board: string;
  jql: string;
  hasToken: boolean;
  tickets: JiraTicket[];
  fetchedAt: number | null;
  /**
   * none: site, email or token missing · pending: configured but not tested yet ·
   * connected: the last query worked · error: the last query failed (see `error`).
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
  /** Empty or omitted = keep the saved token. */
  token?: string;
}

export type AutomationKind = 'smoke' | 'regression' | 'orchestrator';
/** GO / NO-GO for smoke and regression; PASSED… / BLOCKED for the ticket orchestrator. */
export const VERDICTS = ['GO', 'NO-GO', 'PASSED', 'PASSED W/F', 'FAILED', 'BLOCKED'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STEP_STATUSES = ['passed', 'failed', 'blocked', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface ReportStep {
  name: string;
  status: StepStatus;
  notes: string;
}

/** Tested area (Login, Work Orders…) with its steps. */
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
  /** Jira key of the bug, if one was created. */
  key: string;
  link: string;
  module: string;
}

/** A bug as edited from the report: `from` is its position in the list shown before editing (null if it is new). */
export interface ReportBugEdit extends ReportBug {
  from: number | null;
}

/** QA comment for Jira that Claude prepares; the app posts it in one click if Claude could not. */
export interface JiraComment {
  /** Ticket the comment belongs to (e.g. AVM-6926). */
  key: string;
  /** Markdown text, as written by the skill. */
  body: string;
  posted: boolean;
  /** Link to the comment posted from the app. */
  url: string;
  /** Dismissed from the app (for example, because another comment was already posted by hand): it is not posted. */
  dismissed: boolean;
}

/** Detailed QA report Claude sends when it finishes: modules, steps and bugs. */
export interface AutomationDetails {
  /** Version or build tested, if visible on the site. */
  build: string;
  modules: ReportModule[];
  bugs: ReportBug[];
  /** Observations, risks, or what was left untested. */
  notes: string;
  jiraComment: JiraComment | null;
}

/** Summary and report translated to another language (the Jira comment is not translated). */
export interface ReportTranslation {
  summary: string;
  details: AutomationDetails | null;
}

/** Run launched with Claude Code from the app (smoke, regression or orchestrator); Claude reports the result when it finishes. */
export interface Automation {
  id: string;
  kind: AutomationKind;
  /** What is tested: "QA", "STG", the testomat.io test run, or the ticket key. */
  target: string;
  /** Test run record title, without the verdict. */
  title: string;
  env: string;
  startedAt: number;
  finishedAt: number | null;
  verdict: Verdict | null;
  summary: string;
  link: string;
  /** Detailed report; null if Claude only sent the summary. */
  details: AutomationDetails | null;
  /** Test run record that mirrors it: "In progress" when launched, with the verdict when finished. */
  runId: string | null;
  /** Background Claude Code process while it runs (used to stop it). */
  pid: number | null;
  /** Run log (Claude Code stream-json). */
  logFile: string;
  /** Language Claude wrote the summary and report in. */
  lang: Lang;
  /** Translations of the summary and report, made when the app is viewed in another language. */
  translations: Partial<Record<Lang, ReportTranslation>>;
  /** Test mode: Claude only reads Jira and testomat.io; it creates, marks and posts nothing there. */
  dryRun: boolean;
  /**
   * Id of the QA site it runs on: its lane, where runs go one at a time. Empty in runs from before
   * v1.15.0 (their lane is worked out from the kind, target and environment).
   */
  site: string;
}

/** A run waiting for its site's lane to be free. */
export interface QueueItem {
  id: string;
  kind: AutomationKind;
  /** Ticket key, site name (smoke) or test run link (regression), as in Automation.target. */
  target: string;
  /** Lane: id of the QA site it runs on. */
  site: string;
  dryRun: boolean;
  addedAt: number;
}

/** A queued run that was dropped when its turn came (e.g. the ticket left its Jira status). */
export interface QueueSkip {
  id: string;
  kind: AutomationKind;
  target: string;
  reason: string;
  at: number;
}

export interface QueueState {
  /** In order: within each lane, the first one starts when the lane is free. */
  items: QueueItem[];
  /** Lanes that stopped because a run could not start (site id → error); "Resume" clears it. */
  paused: Record<string, string>;
  /** Last runs dropped from the queue, newest first. */
  skipped: QueueSkip[];
}

/** One step of Claude's progress, read from its log. */
export interface ActivityItem {
  kind: 'start' | 'text' | 'tool' | 'result' | 'error';
  text: string;
}

/** What the assistant proposes to do; the app only runs it if the user confirms. */
export type AssistantAction =
  | { type: 'run_smoke'; site: string }
  | { type: 'run_regression'; run: string }
  | { type: 'run_orchestrator'; key: string }
  | { type: 'create_run'; run: TestRunInput }
  | { type: 'post_jira_comment'; automationId: string }
  | { type: 'open_report'; automationId: string };

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantReply {
  reply: string;
  actions: AssistantAction[];
}

export interface AppState {
  settings: Settings;
  runs: TestRun[];
  jira: JiraState;
  automations: Automation[];
  /** Runs waiting for their site's lane. */
  queue: QueueState;
  /** Reports currently being translated to the app language. */
  translating: number;
  /** Demo mode: sample data and simulated Jira/Claude. */
  demo: boolean;
}

export interface Backup extends Settings {
  runs: TestRun[];
  /** QA reports; backups from before v1.14.0 do not have them (importing one keeps the current reports). */
  automations?: Automation[];
}
