import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_JQL, defaultSettings, guessLang, localizeTypes } from '../shared/defaults.js';
import { automationTitle, runText, titleSubject } from './automation.js';
import { parseJiraBoardUrl } from '../shared/jiraBoard.js';
import {
  LANGUAGES, type AppState, type Automation, type Backup, type JiraConnection, type JiraState, type JiraTicket, type Lang,
  type ReportBug, type ReportBugEdit, type ReportTranslation, type Settings, type TestRun, type TestRunInput,
} from '../shared/types.js';

export interface JiraCredentials {
  site: string;
  email: string;
  board: string;
  jql: string;
  token: string;
}

interface StoreData {
  version: 1;
  settings: Settings;
  runs: TestRun[];
  jira: JiraCredentials;
  jiraCache: { tickets: JiraTicket[]; fetchedAt: number | null; ok: boolean | null; error: string | null };
  automations: Automation[];
  /**
   * SHA-256 of each run's report key: only the Claude process that was given the key can report
   * its result. Kept on the server only (never in the state the UI receives).
   */
  reportKeys: Record<string, string>;
}

const emptyData = (): StoreData => ({
  version: 1,
  settings: defaultSettings(),
  runs: [],
  jira: { site: '', email: '', board: '', jql: DEFAULT_JQL, token: '' },
  jiraCache: { tickets: [], fetchedAt: null, ok: null, error: null },
  automations: [],
  reportKeys: {},
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Persistence in a single JSON file. The data volume (a few test runs per day)
 * does not justify a database: everything is kept in memory and every change is
 * written atomically (temporary file + rename).
 */
export class Store {
  private data: StoreData;

  constructor(private readonly file: string) {
    this.data = this.load();
    // Data from earlier versions may have app texts in the other language.
    this.localizeAll();
  }

  /** Default types and app-generated titles and notes in the current language (leaves user edits alone). */
  private localizeAll(): void {
    this.data.settings = { ...this.data.settings, types: localizeTypes(this.data.settings.types, this.data.settings.language) };
    for (const automation of this.data.automations) this.localizeAutomation(automation);
  }

  private load(): StoreData {
    if (!existsSync(this.file)) return emptyData();
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
    const base = emptyData();
    // Files from earlier versions have no `board`.
    return {
      ...base,
      ...saved,
      // Settings from before v1.9.0 have no language.
      settings: { ...base.settings, ...saved.settings },
      jira: { ...base.jira, ...saved.jira },
      jiraCache: { ...base.jiraCache, ...saved.jiraCache },
      // Runs from v1.7.0 had no title.
      automations: (saved.automations ?? []).map((a) => ({
        ...a,
        title: a.title ?? '',
        details: a.details
          ? { ...a.details, jiraComment: a.details.jiraComment ? { ...a.details.jiraComment, dismissed: a.details.jiraComment.dismissed ?? false } : null }
          : null,
        pid: a.pid ?? null,
        logFile: a.logFile ?? '',
        // Before v1.9.2 the language Claude wrote in was not saved.
        // The app generated the title in the language the run was launched with: it is the best hint.
        lang: a.lang ?? guessLang([a.title, a.summary, a.details?.notes, ...(a.details?.modules ?? []).map((m) => m.name)].join(' ')),
        translations: a.translations ?? {},
        dryRun: a.dryRun ?? false,
      })),
      // Before v1.14.0 runs had no report key.
      reportKeys: saved.reportKeys ?? {},
    };
    } catch (cause) {
      // An unreadable file is not overwritten: it could contain recoverable data.
      throw new Error(`Could not read ${this.file}. Fix it or move it to start from scratch.`, { cause });
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // 0600: the file contains the Jira API token.
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  getState(): AppState {
    return { settings: this.data.settings, runs: this.data.runs, jira: this.getJiraState(), automations: this.data.automations, translating: 0, demo: false };
  }

  getJiraState(): JiraState {
    const { site, email, board, jql, token } = this.data.jira;
    const { tickets, fetchedAt, ok, error } = this.data.jiraCache;
    const configured = site !== '' && email !== '' && token !== '';
    const connection: JiraConnection = !configured ? 'none' : ok === null ? 'pending' : ok ? 'connected' : 'error';
    return { site, email, board, jql, hasToken: token !== '', tickets, fetchedAt, connection, error: connection === 'error' ? error : null };
  }

  getJiraCredentials(): JiraCredentials {
    return this.data.jira;
  }

  /**
   * Records a just-launched smoke, regression or orchestrator run (every report is kept).
   * Also creates its "In progress" test run, so the run shows up in Runs as soon as it is launched.
   */
  startAutomation(
    input: Pick<Automation, 'kind' | 'target' | 'env' | 'title'> & { dryRun?: boolean },
    runFor: (a: Automation) => TestRunInput,
  ): Automation {
    const automation: Automation = {
      ...input, dryRun: input.dryRun ?? false, id: randomUUID(), startedAt: Date.now(), finishedAt: null, verdict: null, summary: '', link: '', details: null, runId: null, pid: null, logFile: '',
      lang: this.data.settings.language, translations: {},
    };
    const run: TestRun = { ...runFor(automation), id: randomUUID(), createdAt: automation.startedAt };
    this.data.runs.push(run);
    automation.runId = run.id;
    this.data.automations = [automation, ...this.data.automations];
    this.persist();
    return automation;
  }

  /** Creates the run's report key: returned once (for Claude's prompt) and stored only as a hash. */
  newReportKey(id: string): string {
    const key = randomBytes(24).toString('hex');
    this.data.reportKeys[id] = sha256(key);
    this.persist();
    return key;
  }

  /** Whether a result may be reported with this key. Runs launched before v1.14.0 have none and accept any. */
  acceptsReportKey(id: string, key: string): boolean {
    const expected = this.data.reportKeys[id];
    if (expected === undefined) return true;
    const given = Buffer.from(sha256(key), 'hex');
    return timingSafeEqual(given, Buffer.from(expected, 'hex'));
  }

  /** Saves the process and log of a just-launched run. */
  setAutomationProcess(id: string, pid: number | null, logFile: string): void {
    const automation = this.getAutomation(id);
    if (!automation) return;
    Object.assign(automation, { pid, logFile });
    this.persist();
  }

  getAutomation(id: string): Automation | null {
    return this.data.automations.find((a) => a.id === id) ?? null;
  }

  /** Closes the run with Claude's verdict and the test run that reflects it on the dashboard. */
  finishAutomation(id: string, result: Pick<Automation, 'verdict' | 'summary' | 'link' | 'details'>, runInput: TestRunInput): Automation | null {
    const automation = this.getAutomation(id);
    if (!automation) return null;
    // Updates the "In progress" test run; if the user deleted it, it is created again.
    const existing = this.data.runs.find((r) => r.id === automation.runId);
    if (existing) Object.assign(existing, runInput);
    else {
      const run: TestRun = { ...runInput, id: randomUUID(), createdAt: Date.now() };
      this.data.runs.push(run);
      automation.runId = run.id;
    }
    Object.assign(automation, result, { finishedAt: Date.now(), pid: null });
    // A finished run takes no more reports: its key is no longer needed.
    delete this.data.reportKeys[id];
    this.persist();
    return automation;
  }

  /** Discards the run; if it has not finished, also its "In progress" test run. */
  deleteAutomation(id: string): boolean {
    const automation = this.getAutomation(id);
    if (automation && automation.finishedAt === null) this.data.runs = this.data.runs.filter((r) => r.id !== automation.runId);
    const before = this.data.automations.length;
    this.data.automations = this.data.automations.filter((a) => a.id !== id);
    if (this.data.automations.length === before) return false;
    delete this.data.reportKeys[id];
    this.persist();
    return true;
  }

  createRun(input: TestRunInput): TestRun {
    const run: TestRun = { ...input, id: randomUUID(), createdAt: Date.now() };
    this.data.runs.push(run);
    this.persist();
    return run;
  }

  updateRun(id: string, input: TestRunInput): TestRun | null {
    const index = this.data.runs.findIndex((r) => r.id === id);
    const current = this.data.runs[index];
    if (!current) return null;
    const run: TestRun = { ...input, id, createdAt: current.createdAt };
    this.data.runs[index] = run;
    this.persist();
    return run;
  }

  deleteRun(id: string): boolean {
    const before = this.data.runs.length;
    this.data.runs = this.data.runs.filter((r) => r.id !== id);
    if (this.data.runs.length === before) return false;
    this.persist();
    return true;
  }

  /** Saves the settings; if the language changes, also translates what the app wrote (default types, titles and notes). */
  saveSettings(settings: Settings): Settings {
    const changed = settings.language !== this.data.settings.language;
    this.data.settings = settings;
    if (changed) this.localizeAll();
    this.persist();
    return this.data.settings;
  }

  /** A run's summary in a language: the original or its translation, if there is one. */
  private summaryIn(automation: Automation, lang: Lang): string {
    return automation.lang === lang ? automation.summary : automation.translations[lang]?.summary ?? automation.summary;
  }

  /**
   * Puts the run's title, and its test run's title and notes, in the app language.
   * Only changes the test run if it still has the app-generated text (in any language): user edits are kept.
   */
  private localizeAutomation(automation: Automation): void {
    const lang = this.data.settings.language;
    if (!automation.title) return;
    const subject = titleSubject(automation.title);
    const titleIn = (l: Lang): string => automationTitle(automation.kind, automation.target, l, subject, automation.dryRun);
    const finished = automation.finishedAt !== null;
    const run = this.data.runs.find((r) => r.id === automation.runId);
    if (run) {
      const generated = LANGUAGES.flatMap((l) =>
        [automation.summary, this.summaryIn(automation, l)].map((summary) => runText({ ...automation, title: titleIn(l) }, l, summary, finished)),
      );
      const next = runText({ ...automation, title: titleIn(lang) }, lang, this.summaryIn(automation, lang), finished);
      if (generated.some((g) => g.title === run.title)) run.title = next.title;
      if (generated.some((g) => g.notes === run.notes)) run.notes = next.notes;
    }
    automation.title = titleIn(lang);
  }

  /** Saves a report's translation and, if it is in the app language, updates its test run's notes. */
  saveTranslation(id: string, lang: Lang, translation: ReportTranslation): Automation | null {
    const automation = this.getAutomation(id);
    if (!automation) return null;
    automation.translations = { ...automation.translations, [lang]: translation };
    if (lang === this.data.settings.language) this.localizeAutomation(automation);
    this.persist();
    return automation;
  }

  /**
   * Replaces a finished report's bugs with the list the user edited, in the language it was shown in.
   * The original and every translation get the same bugs: a text the user did not touch keeps each
   * version's own wording; a changed text, the key, the link and the severity are the same in all.
   */
  updateReportBugs(id: string, lang: Lang, edits: ReportBugEdit[]): Automation | null {
    const automation = this.getAutomation(id);
    if (!automation) return null;
    const original = automation.details ?? { build: '', modules: [], bugs: [], notes: '', jiraComment: null };
    const translated = lang === automation.lang ? null : automation.translations[lang]?.details?.bugs;
    const shown = translated ?? original.bugs;
    // A key without a link points to the bug in Jira; if the key changed, so does a link that pointed to the old one.
    const site = this.data.jira.site.replace(/\/+$/, '');
    const jiraLink = (key: string): string => (site && /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? `${site}/browse/${key}` : '');
    const linkOf = (edit: ReportBugEdit, before: ReportBug | undefined): string => {
      const keyChanged = before !== undefined && edit.key !== before.key && edit.link === before.link;
      return edit.link && !keyChanged ? edit.link : jiraLink(edit.key) || (keyChanged ? '' : edit.link);
    };
    const rebase = (version: ReportBug[]): ReportBug[] =>
      edits.map((edit) => {
        const before = edit.from === null ? undefined : shown[edit.from];
        const own = edit.from === null ? undefined : version[edit.from];
        const text = (field: 'title' | 'module'): string => (before && own && edit[field] === before[field] ? own[field] : edit[field]);
        return { title: text('title'), module: text('module'), severity: edit.severity, key: edit.key, link: linkOf(edit, before) };
      });
    const previousCount = original.bugs.length;
    automation.details = { ...original, bugs: rebase(original.bugs) };
    for (const [l, translation] of Object.entries(automation.translations)) {
      if (translation?.details) automation.translations[l as Lang] = { ...translation, details: { ...translation.details, bugs: rebase(translation.details.bugs) } };
    }
    // The test run's bug count follows the list, unless it was set to something else.
    const run = this.data.runs.find((r) => r.id === automation.runId);
    if (run && (run.bugs === null || run.bugs === previousCount)) run.bugs = edits.length;
    this.persist();
    return automation;
  }

  /** Dismisses (or restores) a run's Jira comment: once dismissed, the app does not post it. */
  setJiraCommentDismissed(id: string, dismissed: boolean): Automation | null {
    const automation = this.getAutomation(id);
    const comment = automation?.details?.jiraComment;
    if (!automation || !comment) return null;
    automation.details = { ...automation.details!, jiraComment: { ...comment, dismissed } };
    this.persist();
    return automation;
  }

  /** Marks a run's Jira comment as posted (with the text that was posted). */
  saveJiraCommentPosted(id: string, body: string, url: string): Automation | null {
    const automation = this.getAutomation(id);
    const comment = automation?.details?.jiraComment;
    if (!automation || !comment) return null;
    automation.details = { ...automation.details!, jiraComment: { ...comment, body, posted: true, url } };
    this.persist();
    return automation;
  }

  /** Replaces settings and runs; a backup that includes QA reports (v1.14.0 and later) also replaces them. */
  importBackup({ runs, automations, ...settings }: Backup): void {
    this.data.settings = settings;
    this.data.runs = runs;
    if (automations) {
      // A report still "in progress" in the backup has no process here: it is kept as it is, without a pid.
      this.data.automations = automations.map((a) => ({ ...a, pid: null }));
      this.data.reportKeys = {};
    }
    this.localizeAll();
    this.persist();
  }

  saveJiraConfig(config: { site: string; email: string; board: string; jql: string; token?: string }): void {
    const board = parseJiraBoardUrl(config.board);
    const site = board?.site ?? config.site.replace(/\/+$/, '');
    const origin = (url: string): string => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    };
    // The saved token belongs to its Jira site: it is never sent to a different one.
    const keepToken = origin(site) !== '' && origin(site) === origin(this.data.jira.site);
    this.data.jira = {
      // The board's site wins, so the two cannot get out of sync.
      site,
      email: config.email,
      board: board ? config.board : '',
      // With a board, the JQL is an optional extra filter; without one, it is the whole search.
      jql: board ? (config.jql === DEFAULT_JQL ? '' : config.jql) : config.jql || DEFAULT_JQL,
      token: config.token || (keepToken ? this.data.jira.token : ''),
    };
    // The configuration changed: the connection must be tested again.
    this.data.jiraCache = { ...this.data.jiraCache, ok: null, error: null };
    this.persist();
  }

  saveJiraTickets(tickets: JiraTicket[]): void {
    this.data.jiraCache = { tickets, fetchedAt: Date.now(), ok: true, error: null };
    this.persist();
  }

  /** Records that the last Jira query failed; the previous tickets are kept. */
  saveJiraError(error: string): void {
    this.data.jiraCache = { ...this.data.jiraCache, ok: false, error };
    this.persist();
  }
}
