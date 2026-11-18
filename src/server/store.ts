import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_JQL, defaultSettings } from '../shared/defaults.js';
import { parseJiraBoardUrl } from '../shared/jiraBoard.js';
import type {
  AppState, Backup, JiraConnection, JiraState, JiraTicket, Settings, TestRun, TestRunInput,
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
}

const emptyData = (): StoreData => ({
  version: 1,
  settings: defaultSettings(),
  runs: [],
  jira: { site: '', email: '', board: '', jql: DEFAULT_JQL, token: '' },
  jiraCache: { tickets: [], fetchedAt: null, ok: null, error: null },
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
      jira: { ...base.jira, ...saved.jira },
      jiraCache: { ...base.jiraCache, ...saved.jiraCache },
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
    return { settings: this.data.settings, runs: this.data.runs, jira: this.getJiraState() };
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

  saveSettings(settings: Settings): Settings {
    this.data.settings = settings;
    this.persist();
    return settings;
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
