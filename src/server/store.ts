import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_JQL, defaultSettings, guessLang, localizeTypes } from '../shared/defaults.js';
import { automationTitle, runText, titleSubject } from './automation.js';
import { parseJiraBoardUrl } from '../shared/jiraBoard.js';
import {
  LANGUAGES, type AppState, type Automation, type Backup, type JiraConnection, type JiraState, type JiraTicket, type Lang,
  type ReportTranslation, type Settings, type TestRun, type TestRunInput,
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
}

/** Ejecuciones con Claude que se conservan (las más recientes). */
const MAX_AUTOMATIONS = 30;

const emptyData = (): StoreData => ({
  version: 1,
  settings: defaultSettings(),
  runs: [],
  jira: { site: '', email: '', board: '', jql: DEFAULT_JQL, token: '' },
  jiraCache: { tickets: [], fetchedAt: null, ok: null, error: null },
  automations: [],
});

/**
 * Persistencia en un único archivo JSON. El volumen de datos (unos pocos
 * registros por día) no justifica una base de datos: se mantiene todo en
 * memoria y cada cambio se escribe de forma atómica (archivo temporal + rename).
 */
export class Store {
  private data: StoreData;

  constructor(private readonly file: string) {
    this.data = this.load();
    // Datos de versiones anteriores pueden tener textos de la app en el otro idioma.
    this.localizeAll();
  }

  /** Tipos por defecto, títulos y notas de la app en el idioma actual (no toca lo que editó el usuario). */
  private localizeAll(): void {
    this.data.settings = { ...this.data.settings, types: localizeTypes(this.data.settings.types, this.data.settings.language) };
    for (const automation of this.data.automations) this.localizeAutomation(automation);
  }

  private load(): StoreData {
    if (!existsSync(this.file)) return emptyData();
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
    const base = emptyData();
    // Archivos de versiones anteriores no traen `board`.
    return {
      ...base,
      ...saved,
      // Los ajustes anteriores a la v1.9.0 no traen idioma.
      settings: { ...base.settings, ...saved.settings },
      jira: { ...base.jira, ...saved.jira },
      jiraCache: { ...base.jiraCache, ...saved.jiraCache },
      // Las ejecuciones de la v1.7.0 no traían título.
      automations: (saved.automations ?? []).map((a) => ({
        ...a,
        title: a.title ?? '',
        details: a.details
          ? { ...a.details, jiraComment: a.details.jiraComment ? { ...a.details.jiraComment, dismissed: a.details.jiraComment.dismissed ?? false } : null }
          : null,
        pid: a.pid ?? null,
        logFile: a.logFile ?? '',
        // Antes de la v1.9.2 no se guardaba en qué idioma escribió Claude.
        // El título lo generó la app en el idioma con que se lanzó: es la mejor pista.
        lang: a.lang ?? guessLang([a.title, a.summary, a.details?.notes, ...(a.details?.modules ?? []).map((m) => m.name)].join(' ')),
        translations: a.translations ?? {},
      })),
    };
    } catch (cause) {
      // No se sobrescribe un archivo ilegible: podría contener datos recuperables.
      throw new Error(`No se pudo leer ${this.file}. Corrígelo o muévelo para empezar de cero.`, { cause });
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // 0600: el archivo contiene el API token de Jira.
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  getState(): AppState {
    return { settings: this.data.settings, runs: this.data.runs, jira: this.getJiraState(), automations: this.data.automations, translating: 0 };
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

  /** Registra un smoke o una regresión recién lanzado; se guardan los últimos MAX_AUTOMATIONS. */
  /** Además crea su registro «En progreso», para que la ejecución se vea en Registros desde que se lanza. */
  startAutomation(input: Pick<Automation, 'kind' | 'target' | 'env' | 'title'>, runFor: (a: Automation) => TestRunInput): Automation {
    const automation: Automation = {
      ...input, id: randomUUID(), startedAt: Date.now(), finishedAt: null, verdict: null, summary: '', link: '', details: null, runId: null, pid: null, logFile: '',
      lang: this.data.settings.language, translations: {},
    };
    const run: TestRun = { ...runFor(automation), id: randomUUID(), createdAt: automation.startedAt };
    this.data.runs.push(run);
    automation.runId = run.id;
    this.data.automations = [automation, ...this.data.automations].slice(0, MAX_AUTOMATIONS);
    this.persist();
    return automation;
  }

  /** Guarda el proceso y el log de una ejecución recién lanzada. */
  setAutomationProcess(id: string, pid: number | null, logFile: string): void {
    const automation = this.getAutomation(id);
    if (!automation) return;
    Object.assign(automation, { pid, logFile });
    this.persist();
  }

  getAutomation(id: string): Automation | null {
    return this.data.automations.find((a) => a.id === id) ?? null;
  }

  /** Cierra la ejecución con el veredicto de Claude y el registro que lo refleja en el dashboard. */
  finishAutomation(id: string, result: Pick<Automation, 'verdict' | 'summary' | 'link' | 'details'>, runInput: TestRunInput): Automation | null {
    const automation = this.getAutomation(id);
    if (!automation) return null;
    // Se actualiza el registro «En progreso»; si el usuario lo borró, se crea de nuevo.
    const existing = this.data.runs.find((r) => r.id === automation.runId);
    if (existing) Object.assign(existing, runInput);
    else {
      const run: TestRun = { ...runInput, id: randomUUID(), createdAt: Date.now() };
      this.data.runs.push(run);
      automation.runId = run.id;
    }
    Object.assign(automation, result, { finishedAt: Date.now(), pid: null });
    this.persist();
    return automation;
  }

  /** Descarta la ejecución; si no terminó, también su registro «En progreso». */
  deleteAutomation(id: string): boolean {
    const automation = this.getAutomation(id);
    if (automation && automation.finishedAt === null) this.data.runs = this.data.runs.filter((r) => r.id !== automation.runId);
    const before = this.data.automations.length;
    this.data.automations = this.data.automations.filter((a) => a.id !== id);
    if (this.data.automations.length === before) return false;
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

  /** Guarda los ajustes; si cambia el idioma, también traduce lo que escribió la app (tipos por defecto, títulos y notas). */
  saveSettings(settings: Settings): Settings {
    const changed = settings.language !== this.data.settings.language;
    this.data.settings = settings;
    if (changed) this.localizeAll();
    this.persist();
    return this.data.settings;
  }

  /** Resumen de una ejecución en un idioma: el original o su traducción, si la hay. */
  private summaryIn(automation: Automation, lang: Lang): string {
    return automation.lang === lang ? automation.summary : automation.translations[lang]?.summary ?? automation.summary;
  }

  /**
   * Pone en el idioma de la app el título de la ejecución y el de su registro y sus notas.
   * Solo cambia el registro si conserva el texto que generó la app (en cualquier idioma): si el usuario lo editó, se respeta.
   */
  private localizeAutomation(automation: Automation): void {
    const lang = this.data.settings.language;
    if (!automation.title) return;
    const subject = titleSubject(automation.title);
    const titleIn = (l: Lang): string => automationTitle(automation.kind, automation.target, l, subject);
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

  /** Guarda la traducción de un reporte y, si es la del idioma de la app, actualiza las notas de su registro. */
  saveTranslation(id: string, lang: Lang, translation: ReportTranslation): Automation | null {
    const automation = this.getAutomation(id);
    if (!automation) return null;
    automation.translations = { ...automation.translations, [lang]: translation };
    if (lang === this.data.settings.language) this.localizeAutomation(automation);
    this.persist();
    return automation;
  }

  /** Descarta (o recupera) el comentario de Jira de una ejecución: descartado, la app no lo publica. */
  setJiraCommentDismissed(id: string, dismissed: boolean): Automation | null {
    const automation = this.getAutomation(id);
    const comment = automation?.details?.jiraComment;
    if (!automation || !comment) return null;
    automation.details = { ...automation.details!, jiraComment: { ...comment, dismissed } };
    this.persist();
    return automation;
  }

  /** Marca como publicado el comentario de Jira de una ejecución (con el texto que se publicó). */
  saveJiraCommentPosted(id: string, body: string, url: string): Automation | null {
    const automation = this.getAutomation(id);
    const comment = automation?.details?.jiraComment;
    if (!automation || !comment) return null;
    automation.details = { ...automation.details!, jiraComment: { ...comment, body, posted: true, url } };
    this.persist();
    return automation;
  }

  importBackup({ runs, ...settings }: Backup): void {
    this.data.settings = settings;
    this.data.runs = runs;
    this.persist();
  }

  saveJiraConfig(config: { site: string; email: string; board: string; jql: string; token?: string }): void {
    const board = parseJiraBoardUrl(config.board);
    this.data.jira = {
      // El sitio del board manda: así no pueden quedar desalineados.
      site: board?.site ?? config.site.replace(/\/+$/, ''),
      email: config.email,
      board: board ? config.board : '',
      // Con board, el JQL es un filtro adicional opcional; sin board, la búsqueda completa.
      jql: board ? (config.jql === DEFAULT_JQL ? '' : config.jql) : config.jql || DEFAULT_JQL,
      token: config.token || this.data.jira.token,
    };
    // La configuración cambió: hay que volver a probar la conexión.
    this.data.jiraCache = { ...this.data.jiraCache, ok: null, error: null };
    this.persist();
  }

  saveJiraTickets(tickets: JiraTicket[]): void {
    this.data.jiraCache = { tickets, fetchedAt: Date.now(), ok: true, error: null };
    this.persist();
  }

  /** Registra que la última consulta a Jira falló; se conservan los tickets anteriores. */
  saveJiraError(error: string): void {
    this.data.jiraCache = { ...this.data.jiraCache, ok: false, error };
    this.persist();
  }
}
