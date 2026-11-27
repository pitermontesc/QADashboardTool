import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { toYmd } from '../shared/dates';
import type {
  AppState, AssistantAction, Automation, Backup, JiraConfigInput, JiraTicket, Lang, QueueItem, Settings, TestRun, TestRunInput, Theme,
} from '../shared/types';
import { applyTheme, nextTheme } from './theme';
import { LANGUAGES } from '../shared/types';
import { LangProvider, systemLang } from './i18n';
import { api, isQueued, type LaunchResult } from './api';
import { Dashboard } from './components/Dashboard';
import { canOrchestrate, findSite } from '../shared/orchestrator';
import { JIRA_AUTO_REFRESH_MIN } from './components/Dashboard';
import { RegressionDialog } from './components/RegressionDialog';
import { ValidateAllDialog } from './components/Queue';
import { formatMinutes } from '../shared/queue';
import { AssistantPanel, type ChatMessage } from './components/AssistantPanel';
import { ReportDialog } from './components/ReportDialog';
import { RunForm } from './components/RunForm';
import { RunsView } from './components/RunsView';
import { SettingsView } from './components/SettingsView';
import { Icon, type IconName } from './components/icons';
import { RavnLogo } from './components/RavnLogo';
import { Kbd, MOD } from './components/ui';
import { KIND_LABEL, elapsedMin, reportIn } from './components/Automations';

/** How often the result of a running smoke or regression is polled. */
const AUTOMATION_POLL_MS = 10_000;

type Tab = 'dash' | 'runs' | 'config';
const TABS: ReadonlyArray<{ id: Tab; icon: IconName; key: string }> = [
  { id: 'dash', icon: 'dashboard', key: '1' },
  { id: 'runs', icon: 'list', key: '2' },
  { id: 'config', icon: 'settings', key: '3' },
];

const TEXT = {
  es: {
    tabs: { dash: 'Dashboard', runs: 'Registros', config: 'Tipos y ajustes' } as Record<Tab, string>,
    unexpected: 'Error inesperado',
    demoBadge: 'Demo: datos de ejemplo. Jira y Claude están simulados; nada se publica ni se guarda en tus datos.',
    openFailed: 'No se pudo abrir la app:',
    retry: 'Reintentar',
    loading: 'Cargando…',
    saved: 'Registro guardado',
    deleted: 'Registro borrado',
    ticketsLoaded: (n: number) => (n === 1 ? '1 ticket cargado' : `${n} tickets cargados`),
    jiraConnected: 'Jira conectado',
    ticketsFrom: (n: number, site: string) => `${n === 1 ? '1 ticket cargado' : `${n} tickets cargados`} desde ${site}`,
    newTicketIn: (status: string) => `Nuevo ticket en ${status}`,
    newTickets: 'Nuevos tickets por probar',
    imported: (n: number) => `Respaldo importado: ${n} ${n === 1 ? 'registro' : 'registros'}`,
    restored: (when: string) => `Datos restaurados de la copia del ${when}`,
    orchestratorOpened: (key: string) => `Orquestador QA corriendo en segundo plano para ${key}`,
    regressionOpened: (run: string) => (run ? `Regresión corriendo en segundo plano para ${run}` : 'Regresión corriendo en segundo plano'),
    smokeOpened: (site: string) => `Smoke en ${site} corriendo en segundo plano`,
    running: (n: number) => `${n} ejecuciones en curso`,
    runningShort: (n: number) => `${n} en curso`,
    runningOne: (what: string, min: number) => `En curso · ${what} · ${min} min`,
    inQueue: (n: number) => `${n} en cola`,
    queueOnly: (n: number) => (n === 1 ? '1 en cola' : `${n} en cola`),
    queuedAt: (what: string, n: number) => `${what} en la cola de su sitio (posición ${n}): empieza cuando el sitio se libere`,
    queuedMany: (started: number, waiting: number) =>
      [started === 1 ? '1 empezó' : started > 1 ? `${started} empezaron` : '', waiting > 0 ? `${waiting} en la cola` : ''].filter(Boolean).join(' · '),
    skipped: (what: string) => `${what} salió de la cola`,
    lanePaused: (site: string) => `Cola de ${site} en pausa`,
    batchDone: 'Cola terminada',
    seeProgress: 'Ver el progreso',
    resultSaved: 'Resultado guardado en el dashboard',
    newRun: 'Nuevo registro',
    editRun: 'Editar registro',
    closeToast: 'Cerrar aviso',
    language: 'Idioma',
    assistant: 'Asistente', runCreated: 'Registro creado por el asistente', commentPosted: 'Comentario publicado en Jira',
    themeNames: { system: 'Automático', light: 'Claro', dark: 'Oscuro' } as Record<Theme, string>,
    themeTitle: (current: string, next: string) => `Tema: ${current}. Pulsa para cambiar a ${next}.`,
  },
  en: {
    tabs: { dash: 'Dashboard', runs: 'Runs', config: 'Types & settings' } as Record<Tab, string>,
    unexpected: 'Unexpected error',
    demoBadge: 'Demo: sample data. Jira and Claude are simulated; nothing is posted or saved to your data.',
    openFailed: 'The app could not open:',
    retry: 'Retry',
    loading: 'Loading…',
    saved: 'Run saved',
    deleted: 'Run deleted',
    ticketsLoaded: (n: number) => (n === 1 ? '1 ticket loaded' : `${n} tickets loaded`),
    jiraConnected: 'Jira connected',
    ticketsFrom: (n: number, site: string) => `${n === 1 ? '1 ticket loaded' : `${n} tickets loaded`} from ${site}`,
    newTicketIn: (status: string) => `New ticket in ${status}`,
    newTickets: 'New tickets to test',
    imported: (n: number) => `Backup imported: ${n} ${n === 1 ? 'run' : 'runs'}`,
    restored: (when: string) => `Data restored from the copy of ${when}`,
    orchestratorOpened: (key: string) => `QA orchestrator running in the background for ${key}`,
    regressionOpened: (run: string) => (run ? `Regression running in the background for ${run}` : 'Regression running in the background'),
    smokeOpened: (site: string) => `Smoke on ${site} running in the background`,
    running: (n: number) => `${n} runs in progress`,
    runningShort: (n: number) => `${n} running`,
    runningOne: (what: string, min: number) => `Running · ${what} · ${min} min`,
    inQueue: (n: number) => `${n} queued`,
    queueOnly: (n: number) => `${n} queued`,
    queuedAt: (what: string, n: number) => `${what} queued on its site (position ${n}): it starts when the site is free`,
    queuedMany: (started: number, waiting: number) => [started > 0 ? `${started} started` : '', waiting > 0 ? `${waiting} queued` : ''].filter(Boolean).join(' · '),
    skipped: (what: string) => `${what} left the queue`,
    lanePaused: (site: string) => `${site} queue paused`,
    batchDone: 'Queue finished',
    seeProgress: 'See progress',
    resultSaved: 'Result saved to the dashboard',
    newRun: 'New run',
    editRun: 'Edit run',
    closeToast: 'Close notice',
    language: 'Language',
    assistant: 'Assistant', runCreated: 'Run created by the assistant', commentPosted: 'Comment posted on Jira',
    themeNames: { system: 'Automatic', light: 'Light', dark: 'Dark' } as Record<Theme, string>,
    themeTitle: (current: string, next: string) => `Theme: ${current}. Click to switch to ${next}.`,
  },
} satisfies Record<Lang, unknown>;

type ToastKind = 'ok' | 'error' | 'info';
interface Toast { text: string; kind: ToastKind; id: number }

/** In the desktop app the header doubles as the title bar (the window is dragged from it). */
const IS_DESKTOP = typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent);
if (IS_DESKTOP) document.documentElement.classList.add('desktop');

/** Is focus in a text field? Then single keys are not shortcuts. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Open form: `id` present = editing; absent = new run. */
interface FormState {
  key: number;
  id?: string;
  initial: TestRunInput;
}

const errorMessage = (error: unknown, lang: Lang = systemLang()): string =>
  error instanceof Error ? error.message : TEXT[lang].unexpected;

function blankRun(settings: Settings, overrides: Partial<TestRunInput> = {}): TestRunInput {
  return {
    date: toYmd(new Date()),
    typeId: settings.types[0]?.id ?? '',
    title: '',
    ticket: '',
    env: settings.envs[0] ?? '',
    result: 'passed',
    passed: null,
    failed: null,
    blocked: null,
    bugs: null,
    minutes: null,
    notes: '',
    testMode: false,
    ...overrides,
  };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [regressionOpen, setRegressionOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);
  /** Automation whose QA report is open (read from state so it updates live). */
  const [reportId, setReportId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dash');
  const [form, setForm] = useState<FormState | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** The conversation survives closing and reopening the panel; "New conversation" clears it. */
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const formKey = useRef(0);
  const lang: Lang = state?.settings.language ?? systemLang();
  const t = TEXT[lang];
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const theme: Theme | undefined = state?.settings.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  const notify = useCallback((text: string, kind: ToastKind = 'ok') => setToast({ text, kind, id: Date.now() }), []);
  const fail = useCallback((error: unknown) => notify(errorMessage(error), 'error'), [notify]);
  /** Stable, so cards that load on mount do not load again on every render. */
  const notifyError = useCallback((message: string) => notify(message, 'error'), [notify]);
  /** Important notice: a toast and, if the system allows it (the desktop app does), a native notification. */
  const announce = useCallback(
    (title: string, body: string) => {
      notify(`${title}: ${body}`);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
      } catch {
        // Without system notifications the toast is enough.
      }
    },
    [notify],
  );

  // Jira tickets (and a Mac that was not ready) refresh on their own: every few minutes and when the window regains focus.
  const autoRefresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const tick = (): void => autoRefresh.current();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = setInterval(tick, JIRA_AUTO_REFRESH_MIN * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // While Claude runs an automation or reports are being translated, state is polled every few seconds.
  const running =
    (state?.automations.some((a) => a.finishedAt === null) ?? false) || (state?.translating ?? 0) > 0 || (state?.queue.items.length ?? 0) > 0;
  /**
   * Goes up with every change made here and every server state applied. A background refresh asked
   * before either is dropped (the next one brings the news), so a slow answer cannot bring back a run
   * just deleted, undo a run that already finished, or announce the same result twice.
   */
  const generation = useRef(0);
  /** Applies a polled state and announces what changed since the state shown now. */
  const applyPolled = useEffectEvent((next: AppState) => {
    const before = new Map(state?.automations.map((a) => [a.id, a]));
    const queueBefore = state?.queue;
    setState((s) => (s ? { ...s, runs: next.runs, automations: next.automations, queue: next.queue, translating: next.translating, setup: next.setup ?? s.setup } : s));
    const current = state?.settings.language ?? 'es';
    for (const a of next.automations) {
      if (a.finishedAt !== null && before.get(a.id)?.finishedAt === null) {
        const what =
          a.kind === 'smoke' ? `Smoke ${a.target}` : a.kind === 'orchestrator' ? a.target : `Regression ${a.target}`.trim();
        announce(`${what}: ${a.verdict}`, reportIn(a, current).summary || TEXT[current].resultSaved);
      }
    }
    // After the results (a finished run can cause these). A queued run that was dropped when its turn came, or a site that stopped: say why.
    const seen = new Set(queueBefore?.skipped.map((q) => q.id));
    for (const skip of next.queue.skipped) {
      if (queueBefore && !seen.has(skip.id)) announce(TEXT[current].skipped(skip.kind === 'orchestrator' ? skip.target : `${skip.kind} ${skip.target}`), skip.reason);
    }
    for (const [site, why] of Object.entries(next.queue.paused)) {
      if (queueBefore && queueBefore.paused[site] === undefined) {
        announce(TEXT[current].lanePaused(next.settings.qa.sites.find((x) => x.id === site)?.name ?? site), why);
      }
    }
    // Last, so it is the notice left on screen. A whole batch is done: "4 PASSED · 1 FAILED · 1 BLOCKED · 2 h 10 min".
    const known = new Set(queueBefore?.finished.map((b) => b.batch));
    for (const done of next.queue.finished) {
      if (queueBefore && !known.has(done.batch)) {
        const counts = Object.entries(done.verdicts).map(([verdict, n]) => `${n} ${verdict}`);
        announce(TEXT[current].batchDone, [...counts, formatMinutes(done.minutes).replace('~', '')].join(' · '));
      }
    }
  });
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const asked = generation.current;
      api
        .getState()
        .then((next) => {
          if (asked !== generation.current) return;
          generation.current++;
          applyPolled(next);
        })
        .catch(() => undefined);
    }, AUTOMATION_POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!toast) return;
    // Errors stay longer so they can be read.
    const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 7000 : 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Asks the server to check the Mac again. Only the check and the skill names (the check may switch
   * one to the name Claude Code has) are taken, so nothing being edited is overwritten.
   */
  const checkSetup = useCallback(async (): Promise<void> => {
    const next = await api.checkSetup();
    setState((s) => (s ? { ...s, setup: next.setup, settings: { ...s.settings, qa: { ...s.settings.qa, skills: next.settings.qa.skills } } } : s));
  }, []);

  useEffect(() => {
    api.getState().then(
      (next) => {
        setState(next);
        // The server checks the Mac as it starts; a window opened before that check ends asks for it.
        if (!next.setup) void checkSetup().catch(() => undefined);
      },
      (error: unknown) => setLoadError(errorMessage(error)),
    );
  }, [checkSetup]);

  // Desktop app menu commands and keyboard shortcuts. Kept in a ref so the listener
  // (registered once) always sees the current state.
  const commands = useRef<(command: string) => void>(() => undefined);
  useEffect(() => {
    const onCommand = (event: Event): void => commands.current((event as CustomEvent<string>).detail);
    const onKey = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]')) return;
      const mod = event.metaKey || event.ctrlKey;
      // On desktop the menu already handles ⌘N, ⌘1… (they never reach here); in the browser they do.
      if (mod && /^[123]$/.test(event.key)) {
        event.preventDefault();
        commands.current(`tab:${TABS[Number(event.key) - 1]!.id}`);
      } else if (mod && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        commands.current('assistant');
      } else if (!mod && !event.altKey && !typing(event.target)) {
        if (event.key === 'n' || event.key === 'N') {
          event.preventDefault();
          commands.current('new-run');
        } else if (event.key === '/') {
          event.preventDefault();
          commands.current('search');
        }
      }
    };
    window.addEventListener('app-command', onCommand);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('app-command', onCommand);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (loadError) {
    return (
      <main>
        <div className="empty-state">
          <p className="text-bad">{t.openFailed} {loadError}</p>
          <button className="btn" onClick={() => location.reload()}>{t.retry}</button>
        </div>
      </main>
    );
  }
  if (!state) return <main><div className="loading"><span className="spinner" /> {t.loading}</div></main>;

  /** Every change to the state goes through here, so an older background refresh cannot overwrite it. */
  const update = (change: (s: AppState) => AppState): void => {
    generation.current++;
    setState((s) => (s ? change(s) : s));
  };
  const patch = (changes: Partial<AppState>): void => update((s) => ({ ...s, ...changes }));
  /** Replaces one automation in the current state (not in the state this render saw). */
  const putAutomation = (updated: Automation): void =>
    update((s) => ({ ...s, automations: s.automations.map((a) => (a.id === updated.id ? updated : a)) }));
  const openForm = (initial: TestRunInput, id?: string): void => setForm({ key: ++formKey.current, id, initial });

  const saveRun = async (input: TestRunInput): Promise<boolean> => {
    try {
      const editingId = form?.id;
      const saved = editingId ? await api.updateRun(editingId, input) : await api.createRun(input);
      update((s) => ({ ...s, runs: editingId ? s.runs.map((r) => (r.id === saved.id ? saved : r)) : [...s.runs, saved] }));
      notify(t.saved);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const deleteRun = async (run: TestRun): Promise<void> => {
    try {
      await api.deleteRun(run.id);
      update((s) => ({ ...s, runs: s.runs.filter((r) => r.id !== run.id) }));
      notify(t.deleted);
    } catch (error) {
      fail(error);
    }
  };

  const saveSettings = async (settings: Settings): Promise<void> => {
    const previous = state.settings;
    patch({ settings }); // Optimistic: settings respond instantly and revert if saving fails.
    try {
      const saved = await api.saveSettings(settings);
      if (saved.language !== previous.language) {
        // On a language change the server translates types, titles and notes, and starts translating Claude's reports.
        const next = await api.getState();
        patch({ settings: next.settings, runs: next.runs, automations: next.automations, translating: next.translating });
      } else patch({ settings: saved });
    } catch (error) {
      patch({ settings: previous });
      fail(error);
    }
  };

  const refreshJira = async (): Promise<void> => {
    setJiraLoading(true);
    try {
      const wasConnected = state.jira.connection === 'connected';
      const jira = await api.refreshJira();
      patch({ jira });
      if (wasConnected) {
        notify(t.ticketsLoaded(jira.tickets.length));
      } else {
        announce(t.jiraConnected, t.ticketsFrom(jira.tickets.length, jira.site.replace(/^https?:\/\//, '')));
      }
    } catch (error) {
      fail(error);
      // The server stored the connection error: reload state to show it.
      api.getState().then((next) => patch({ jira: next.jira })).catch(() => undefined);
    } finally {
      setJiraLoading(false);
    }
  };

  /**
   * Automatic refresh: silent except for new tickets in On QA / On Staging.
   * Kept in a ref, not a hook: it needs the loaded state and the handlers defined after the loading
   * return. The timer above calls it from an event, never while rendering.
   */
  // oxlint-disable-next-line react/refs
  autoRefresh.current = () => {
    // Back from Terminal after fixing something: a Mac that was not ready is checked again.
    if (state.setup && !state.setup.ready) void checkSetup().catch(() => undefined);
    const { jira } = state;
    if (jiraLoading || !jira.hasToken || jira.connection === 'none') return;
    // When returning to the window, skip if the last load was very recent.
    if (jira.fetchedAt !== null && Date.now() - jira.fetchedAt < 60_000) return;
    const known = new Set(jira.tickets.map((t) => t.key));
    setJiraLoading(true);
    api
      .refreshJira()
      .then((next) => {
        patch({ jira: next });
        const fresh = next.tickets.filter((t) => !known.has(t.key) && canOrchestrate(t.status, state.settings.qa));
        if (fresh.length === 1) announce(t.newTicketIn(fresh[0]!.status), `${fresh[0]!.key} · ${fresh[0]!.summary}`);
        else if (fresh.length > 1) announce(t.newTickets, fresh.map((t) => t.key).join(', '));
      })
      // The error shows in the card's connection status; no interrupting toast.
      .catch(() => api.getState().then((next) => patch({ jira: next.jira })).catch(() => undefined))
      .finally(() => setJiraLoading(false));
  };

  const saveJira = async (config: JiraConfigInput): Promise<void> => {
    try {
      const jira = await api.saveJiraConfig(config);
      patch({ jira });
      if (!state.settings.ticketBase && jira.site) {
        await saveSettings({ ...state.settings, ticketBase: `${jira.site}/browse/` });
      }
      await refreshJira();
    } catch (error) {
      fail(error);
    }
  };

  const importBackup = async (backup: Backup): Promise<void> => {
    try {
      const next = await api.importBackup(backup);
      update(() => next);
      notify(t.imported(next.runs.length));
    } catch (error) {
      fail(error);
    }
  };

  /** Brings back an automatic copy; the card shows the error if it cannot. */
  const restoreBackup = async (name: string, when: string): Promise<void> => {
    const next = await api.restoreBackup(name);
    update(() => next);
    notify(t.restored(when));
  };

  const newFromTicket = (ticket: JiraTicket): void => {
    const functional = state.settings.types.find((t) => /funcional|functional/i.test(t.name));
    openForm(blankRun(state.settings, { ticket: ticket.key, title: ticket.summary, ...(functional && { typeId: functional.id }) }));
  };

  /**
   * After a launch: its "In progress" run is already in Runs, or it waits in its site's queue.
   * `started` is the notice for a run that started; `what` names it for the queued notice.
   */
  const afterLaunch = async (result: LaunchResult, started: string, what: string): Promise<void> => {
    const next = await api.getState().catch(() => null);
    if (next) patch({ runs: next.runs, automations: next.automations, queue: next.queue });
    else if (!isQueued(result)) update((s) => ({ ...s, automations: [result, ...s.automations] }));
    notify(isQueued(result) ? t.queuedAt(what, result.position) : started, 'info');
  };

  /** Queue changes answer with the whole state: what started, what is waiting. */
  const applyQueue = async (call: () => Promise<AppState>): Promise<boolean> => {
    try {
      const next = await call();
      patch({ runs: next.runs, automations: next.automations, queue: next.queue });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  const queueTickets = async (keys: string[]): Promise<boolean> => {
    let next: AppState | null = null;
    const ok = await applyQueue(async () => (next = await api.queueTickets(keys)));
    if (ok && next) {
      // The first ticket of each free site starts at once: say how many started and how many wait.
      const { automations, queue } = next as AppState;
      const started = keys.filter((k) => automations.some((a) => a.kind === 'orchestrator' && a.target === k && a.finishedAt === null)).length;
      const waiting = keys.filter((k) => queue.items.some((q) => q.kind === 'orchestrator' && q.target === k)).length;
      notify(t.queuedMany(started, waiting), 'info');
    }
    return ok;
  };

  const runOrchestrator = async (ticket: JiraTicket, fullCoverage = false): Promise<boolean> => {
    setLaunching(fullCoverage ? `full:${ticket.key}` : ticket.key);
    try {
      await afterLaunch(await api.runOrchestrator(ticket.key, fullCoverage), t.orchestratorOpened(ticket.key), ticket.key);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setLaunching(null);
    }
  };

  const runRegression = async (run: string, dryRun = false): Promise<boolean> => {
    try {
      await afterLaunch(await api.runRegression(run, dryRun), t.regressionOpened(run), `${KIND_LABEL[lang].regression} ${run}`.trim());
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    }
  };

  const runSmoke = async (siteId: string): Promise<boolean> => {
    setLaunching(`smoke:${siteId}`);
    try {
      const name = findSite(siteId, state.settings.qa)?.name ?? siteId;
      await afterLaunch(await api.runSmoke(siteId), t.smokeOpened(name), `Smoke ${name}`);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setLaunching(null);
    }
  };

  const dismissAutomation = async (automation: Automation): Promise<void> => {
    try {
      await api.deleteAutomation(automation.id);
      // If it had not finished, its "In progress" run was removed too.
      const next = await api.getState();
      patch({ runs: next.runs, automations: next.automations });
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const toInput = ({ id: _id, createdAt: _createdAt, ...input }: TestRun): TestRunInput => input;
  const newRun = (): void => openForm(blankRun(state.settings));

  // Like autoRefresh: set here, after the loading return, and only called from the listener above.
  // oxlint-disable-next-line react/refs
  commands.current = (command) => {
    if (command === 'new-run') {
      if (!form) newRun();
    } else if (command === 'refresh-jira') {
      if (!jiraLoading && state.jira.connection !== 'none') void refreshJira();
    } else if (command === 'search') {
      setTab('runs');
      setTimeout(() => document.getElementById('runs-search')?.focus(), 0);
    } else if (command === 'assistant') {
      setAssistantOpen((open) => !open);
    } else if (command.startsWith('theme:')) {
      const next = command.slice(6);
      if (next === 'system' || next === 'light' || next === 'dark') void saveSettings({ ...state.settings, theme: next });
    } else if (command.startsWith('tab:')) {
      setTab(command.slice(4) as Tab);
    }
  };

  const report = reportId ? state.automations.find((a) => a.id === reportId) : undefined;
  const active = state.automations.filter((a) => a.finishedAt === null);
  const queued = state.queue.items.length;
  /** False if it could not be stopped (e.g. it reported just before). Either way the state is reloaded. */
  const stopAutomation = async (automation: Automation): Promise<boolean> => {
    let stopped = false;
    try {
      await api.stopAutomation(automation.id);
      stopped = true;
    } catch (err) {
      notify((err as Error).message, 'error');
    }
    const next = await api.getState().catch(() => null);
    if (next) patch({ runs: next.runs, automations: next.automations });
    return stopped;
  };

  /** Assistant action, confirmed by the user: same logic as the app's buttons. */
  const doAssistantAction = async (action: AssistantAction): Promise<boolean> => {
    try {
      switch (action.type) {
        case 'run_smoke':
          return await runSmoke(action.site);
        case 'run_regression':
          return await runRegression(action.run);
        case 'run_orchestrator': {
          const ticket = state.jira.tickets.find((tk) => tk.key === action.key);
          return ticket ? await runOrchestrator(ticket) : false;
        }
        case 'create_run': {
          const saved = await api.createRun(action.run);
          update((s) => ({ ...s, runs: [...s.runs, saved] }));
          notify(t.runCreated);
          return true;
        }
        case 'post_jira_comment': {
          const body = state.automations.find((a) => a.id === action.automationId)?.details?.jiraComment?.body ?? '';
          const updated = await api.postJiraComment(action.automationId, body);
          putAutomation(updated);
          notify(t.commentPosted);
          return true;
        }
        case 'open_report':
          setReportId(action.automationId);
          return true;
      }
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const setLanguage = (language: Lang): void => {
    if (language !== lang) void saveSettings({ ...state.settings, language });
  };

  return (
    <LangProvider value={lang}>
      <header>
        <div className="brand">
          <RavnLogo />
          <span className="brand-sep" aria-hidden="true" />
          <h1>QA <span>Dashboard</span></h1>
          {state.demo && <span className="demo-badge" title={t.demoBadge}>DEMO</span>}
        </div>
        <nav>
          {TABS.map((item) => (
            <button
              key={item.id}
              className={item.id === tab ? 'on' : ''}
              aria-current={item.id === tab ? 'page' : undefined}
              title={`${MOD}${item.key}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} />
              {t.tabs[item.id]}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {(active.length > 0 || queued > 0) && (
          <button className="running-indicator" onClick={() => (active[0] ? setReportId(active[0].id) : setTab('dash'))} title={t.seeProgress}>
            <i className="run-dot" />
            {active.length === 1
              ? t.runningOne(`${KIND_LABEL[lang][active[0]!.kind]} ${active[0]!.target}`.trim(), elapsedMin(active[0]!))
              : active.length > 1
                ? (queued > 0 ? t.runningShort(active.length) : t.running(active.length))
                : t.queueOnly(queued)}
            {active.length > 0 && queued > 0 && ` · ${t.inQueue(queued)}`}
          </button>
        )}
        <button
          className={`btn small assistant-btn${assistantOpen ? ' on' : ''}`}
          onClick={() => setAssistantOpen((open) => !open)}
          title={`${t.assistant} (${MOD}K)`}
          aria-label={t.assistant}
          aria-expanded={assistantOpen}
        >
          <Icon name="sparkle" /> <span className="assistant-label">{t.assistant}</span>
        </button>
        {(() => {
          const next = nextTheme(state.settings.theme);
          const icon = state.settings.theme === 'dark' ? 'moon' : state.settings.theme === 'light' ? 'sun' : 'auto';
          const title = t.themeTitle(t.themeNames[state.settings.theme], t.themeNames[next]);
          return (
            <button className="icon-btn theme-btn" onClick={() => void saveSettings({ ...state.settings, theme: next })} title={title} aria-label={title}>
              <Icon name={icon} />
            </button>
          );
        })()}
        <div className="lang-switch" role="group" aria-label={t.language}>
          {LANGUAGES.map((l) => (
            <button key={l} className={l === lang ? 'on' : ''} aria-pressed={l === lang} onClick={() => setLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="btn primary new-run-btn" onClick={newRun} title={`${t.newRun} (${MOD}N)`} aria-label={t.newRun}>
          <Icon name="plus" /> <span className="new-run-label">{t.newRun}</span> <Kbd>{MOD}N</Kbd>
        </button>
      </header>

      <main>
        {tab === 'dash' && (
          <Dashboard
            state={state}
            jiraLoading={jiraLoading}
            onRefreshJira={refreshJira}
            onTicket={newFromTicket}
            onOrchestrate={runOrchestrator}
            launching={launching}
            onRegression={() => setRegressionOpen(true)}
            onValidateAll={() => setValidateOpen(true)}
            onQueueMove={(item: QueueItem, direction: 'up' | 'down') => void applyQueue(() => api.moveQueued(item.id, direction))}
            onQueueRemove={(item: QueueItem) => void applyQueue(() => api.removeQueued(item.id))}
            onQueueResume={(site: string) => void applyQueue(() => api.resumeLane(site))}
            onSmoke={runSmoke}
            onDismissAutomation={dismissAutomation}
            onOpenReport={(a) => setReportId(a.id)}
            onNewRun={newRun}
            onOpenSettings={() => setTab('config')}
          />
        )}
        {tab === 'runs' && (
          <RunsView
            state={state}
            onEdit={(run) => openForm(toInput(run), run.id)}
            onDuplicate={(run) => openForm({ ...toInput(run), date: toYmd(new Date()) })}
            onDelete={deleteRun}
            onOpenReport={(a) => setReportId(a.id)}
          />
        )}
        {tab === 'config' && (
          <SettingsView
            state={state}
            jiraLoading={jiraLoading}
            onSaveSettings={saveSettings}
            onSaveJira={saveJira}
            onImport={importBackup}
            onRestore={restoreBackup}
            onCheckSetup={checkSetup}
            onSetup={(setup) => patch({ setup })}
            onNotice={notify}
            onError={notifyError}
          />
        )}
      </main>

      {form && (
        <RunForm
          key={form.key}
          heading={form.id ? t.editRun : t.newRun}
          initial={form.initial}
          settings={state.settings}
          onSubmit={saveRun}
          onClose={() => setForm(null)}
        />
      )}
      {assistantOpen && (
        <AssistantPanel state={state} messages={chat} setMessages={setChat} onClose={() => setAssistantOpen(false)} onAction={doAssistantAction} />
      )}
      {validateOpen && <ValidateAllDialog state={state} onConfirm={queueTickets} onClose={() => setValidateOpen(false)} />}
      {regressionOpen && <RegressionDialog qa={state.settings.qa} onLaunch={runRegression} onClose={() => setRegressionOpen(false)} />}
      {report && (
        <ReportDialog
          key={report.id}
          automation={report}
          run={state.runs.find((r) => r.id === report.runId)}
          automations={state.automations}
          onClose={() => setReportId(null)}
          onStop={stopAutomation}
          onUpdate={(updated) => {
            putAutomation(updated);
            // Editing the bugs can change the test run's bug count.
            void api.getState().then((next) => patch({ runs: next.runs }), () => undefined);
          }}
          onError={fail}
        />
      )}
      <div className={`toast${toast ? ` on ${toast.kind}` : ''}`} role={toast?.kind === 'error' ? 'alert' : 'status'}>
        {toast && (
          <>
            <Icon name={toast.kind === 'error' ? 'alert' : 'check'} />
            <span>{toast.text}</span>
            <button className="toast-close" aria-label={t.closeToast} onClick={() => setToast(null)}>
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </div>
    </LangProvider>
  );
}
