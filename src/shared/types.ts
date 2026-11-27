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
  /**
   * A rehearsal (a regression in test mode, or one marked by hand): it stays in Runs with its report,
   * but the dashboard's numbers and charts leave it out.
   */
  testMode: boolean;
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
  /** Key of its parent (the epic, usually); empty if none. */
  epic: string;
  /** Keys of the tickets it "is blocked by" in Jira. */
  blockedBy: string[];
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
  /** Orchestrator with full coverage: every agent of the skill runs, whatever the ticket size. */
  fullCoverage: boolean;
  /**
   * Id of the QA site it runs on: its lane, where runs go one at a time. Empty in runs from before
   * v1.15.0 (their lane is worked out from the kind, target and environment).
   */
  site: string;
  /** Jira issue type of an orchestrator run's ticket (Bug, Story…), for duration estimates; empty if unknown. */
  ticketType: string;
  /** Set when the run came from the queue: its batch ("Validate all" click or single launch) and automatic retries so far. */
  queued: { batch: string; retries: number } | null;
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
  /** Orchestrator with full coverage (see Automation.fullCoverage). */
  fullCoverage: boolean;
  addedAt: number;
  /** Runs queued together ("Validate all" or one launch): a summary is shown when the whole batch is done. */
  batch: string;
  /** Automatic retries so far (a run BLOCKED by the environment is retried once). */
  retries: number;
}

/** Summary of a finished batch of queued runs. */
export interface QueueBatchDone {
  batch: string;
  at: number;
  /** Final verdict of each run (the last attempt), by verdict. */
  verdicts: Partial<Record<Verdict, number>>;
  /** From the first start to the last end. */
  minutes: number;
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
  /** Last finished batches, newest first. */
  finished: QueueBatchDone[];
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

/** A person in the QA profile: their Jira name and accountId. */
export interface QaPerson {
  name: string;
  accountId: string;
}

/**
 * The QA profile the AVM skills read (`~/.config/avm-qa/profile.json`): who runs them, to assign
 * tickets and sign reports, and who runs the TCs once a ticket passes QA.
 */
export interface QaProfile {
  /** Where it is, with the home folder as `~`. */
  file: string;
  exists: boolean;
  /** The file exists but is not JSON the app can read. */
  unreadable: boolean;
  tester: QaPerson | null;
  tcExecutor: QaPerson | null;
}

/** A QA in the team view: their runs and reports, as their app shared them in the team folder. */
export interface TeamMember {
  /** Stable id of that person's app (not their email or Jira account). */
  id: string;
  name: string;
  /** Version of the app that wrote the file. */
  app: string;
  /** When their app last wrote it. */
  updatedAt: number;
  /** The file in the team folder. */
  file: string;
  /** This Mac's own data. */
  me: boolean;
  types: TestType[];
  runs: TestRun[];
  automations: Automation[];
}

/** The team view: where it is shared, and what this app sees there. */
export interface TeamState {
  /** The synced folder the team shares; empty when this app is not in a team. */
  folder: string;
  /** The name the team sees for this app's data. */
  name: string;
  /** This app's file in the folder (empty until the first write). */
  ownFile: string;
  /** When this app last wrote its file. */
  writtenAt: number | null;
  /** When the folder was last read. */
  readAt: number | null;
  /** The folder could not be read or written (missing, not synced, no permission). */
  error: string | null;
}

/** GET /api/team: the state, everyone's data (this Mac's first) and files that could not be read. */
export interface TeamView extends TeamState {
  members: TeamMember[];
  problems: { file: string; error: string }[];
}

/** A published version of the app (a GitHub release). */
export interface ReleaseInfo {
  version: string;
  /** The release page. */
  url: string;
  publishedAt: number | null;
  /** What changed, as written in the release (plain text). */
  notes: string;
  /** The installers: a .dmg and a .zip per Mac architecture. */
  downloads: { name: string; url: string; arch: 'arm64' | 'x64'; kind: 'dmg' | 'zip' }[];
}

/** Whether a newer version of the app is published. */
export interface UpdateState {
  current: string;
  /** This Mac's architecture: which installer to offer. */
  arch: string;
  latest: ReleaseInfo | null;
  /** `latest` is newer than `current`. */
  available: boolean;
  checkedAt: number | null;
  /** The last check failed (no connection, GitHub down); the app keeps working. */
  error: string | null;
}

/** Something this Mac needs for runs with Claude. */
export type SetupCheckId = 'claude' | 'login' | 'skills' | 'chrome' | 'profile' | 'jira';
/** `invalid`: the QA profile exists but lacks the tester's name or accountId. `unknown`: it could not be checked. */
export type SetupStatus = 'ok' | 'missing' | 'invalid' | 'unknown';

export interface SetupCheck {
  id: SetupCheckId;
  status: SetupStatus;
  /** Missing, it stops runs with Claude from launching; the others are only advice. */
  required: boolean;
  /** What was found: Claude's version, the tester's name, the Jira site, the skills that are missing. */
  detail: string;
}

/** One configured skill, and whether Claude Code has it. */
export interface SkillCheck {
  kind: AutomationKind;
  name: string;
  status: SetupStatus;
  /** The app changed the name to the one Claude Code has (for example, with the plugin's prefix). */
  renamedFrom?: string;
}

/** Whether this Mac is ready for runs with Claude Code, and what to fix if not. */
export interface SetupState {
  checkedAt: number;
  /** No required check is missing: runs with Claude can launch. */
  ready: boolean;
  checks: SetupCheck[];
  skills: SkillCheck[];
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
  /** What this Mac has for runs with Claude; null until the first check finishes. */
  setup: SetupState | null;
  /** Updates: null in the demo and before the first check is asked for. */
  update: UpdateState | null;
  /** The team folder this app shares in. */
  team: TeamState;
}

export interface Backup extends Settings {
  runs: TestRun[];
  /** QA reports; backups from before v1.14.0 do not have them (importing one keeps the current reports). */
  automations?: Automation[];
}

/** Why an automatic copy of the data file was taken. */
export type BackupReason = 'daily' | 'before-import' | 'before-restore' | 'manual';

/** An automatic copy of the data file, in `backups/` next to it. */
export interface BackupInfo {
  name: string;
  /** When the copy was taken. */
  at: number;
  reason: BackupReason;
  size: number;
  runs: number;
  reports: number;
}

export interface BackupList {
  dir: string;
  /** Newest first. */
  items: BackupInfo[];
  /** The copy just made by "Back up now". */
  created?: string;
}
