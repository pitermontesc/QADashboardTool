import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_JQL, defaultSettings } from '../shared/defaults.js';
import type {
  AppState, Backup, JiraState, JiraTicket, Settings, TestRun, TestRunInput,
} from '../shared/types.js';

export interface JiraCredentials {
  site: string;
  email: string;
  jql: string;
  token: string;
}

interface StoreData {
  version: 1;
  settings: Settings;
  runs: TestRun[];
  jira: JiraCredentials;
  jiraCache: { tickets: JiraTicket[]; fetchedAt: number | null };
}

const emptyData = (): StoreData => ({
  version: 1,
  settings: defaultSettings(),
  runs: [],
  jira: { site: '', email: '', jql: DEFAULT_JQL, token: '' },
  jiraCache: { tickets: [], fetchedAt: null },
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
      return { ...emptyData(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>) };
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
    const { site, email, jql, token } = this.data.jira;
    return { site, email, jql, hasToken: token !== '', ...this.data.jiraCache };
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

  saveJiraConfig(config: { site: string; email: string; jql: string; token?: string }): void {
    this.data.jira = {
      site: config.site.replace(/\/+$/, ''),
      email: config.email,
      jql: config.jql || DEFAULT_JQL,
      token: config.token || this.data.jira.token,
    };
    this.persist();
  }

  saveJiraTickets(tickets: JiraTicket[]): void {
    this.data.jiraCache = { tickets, fetchedAt: Date.now() };
    this.persist();
  }
}
