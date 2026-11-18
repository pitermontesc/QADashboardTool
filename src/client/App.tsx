import { useCallback, useEffect, useRef, useState } from 'react';
import { toYmd } from '../shared/dates';
import type {
  AppState, Automation, Backup, JiraConfigInput, JiraTicket, Lang, Settings, TestRun, TestRunInput,
} from '../shared/types';
import { LANGUAGES } from '../shared/types';
import { LangProvider, systemLang } from './i18n';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { SMOKE_SITES, canOrchestrate, type SmokeSite } from '../shared/orchestrator';
import { JIRA_AUTO_REFRESH_MIN } from './components/Dashboard';
import { RegressionDialog } from './components/RegressionDialog';
import { ReportDialog } from './components/ReportDialog';
import { RunForm } from './components/RunForm';
import { RunsView } from './components/RunsView';
import { SettingsView } from './components/SettingsView';
import { Icon, type IconName } from './components/icons';
import { RavnLogo } from './components/RavnLogo';
import { Kbd, MOD } from './components/ui';
import { KIND_LABEL, elapsedMin, reportIn } from './components/Automations';

/** Cada cuánto se consulta el resultado de un smoke o una regresión en curso. */
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
    openFailed: 'No se pudo abrir la app:',
    retry: 'Reintentar',
    loading: 'Cargando…',
    saved: 'Registro guardado',
    deleted: 'Registro borrado',
    ticketsLoaded: (n: number) => `${n} tickets cargados`,
    jiraConnected: 'Jira conectado',
    ticketsFrom: (n: number, site: string) => `${n} tickets cargados desde ${site}`,
    newTicketIn: (status: string) => `Nuevo ticket en ${status}`,
    newTickets: 'Nuevos tickets por probar',
    imported: (n: number) => `Respaldo importado: ${n} registros`,
    orchestratorOpened: (key: string) => `Orquestador QA corriendo en segundo plano para ${key}`,
    regressionOpened: (run: string) => (run ? `Regresión corriendo en segundo plano para ${run}` : 'Regresión corriendo en segundo plano'),
    smokeOpened: (site: string) => `Smoke en ${site} corriendo en segundo plano`,
    running: (n: number) => `${n} ejecuciones en curso`,
    seeProgress: 'Ver el progreso',
    resultSaved: 'Resultado guardado en el dashboard',
    newRun: 'Nuevo registro',
    editRun: 'Editar registro',
    closeToast: 'Cerrar aviso',
    language: 'Idioma',
  },
  en: {
    tabs: { dash: 'Dashboard', runs: 'Runs', config: 'Types & settings' } as Record<Tab, string>,
    unexpected: 'Unexpected error',
    openFailed: 'The app could not open:',
    retry: 'Retry',
    loading: 'Loading…',
    saved: 'Run saved',
    deleted: 'Run deleted',
    ticketsLoaded: (n: number) => `${n} tickets loaded`,
    jiraConnected: 'Jira connected',
    ticketsFrom: (n: number, site: string) => `${n} tickets loaded from ${site}`,
    newTicketIn: (status: string) => `New ticket in ${status}`,
    newTickets: 'New tickets to test',
    imported: (n: number) => `Backup imported: ${n} runs`,
    orchestratorOpened: (key: string) => `QA orchestrator running in the background for ${key}`,
    regressionOpened: (run: string) => (run ? `Regression running in the background for ${run}` : 'Regression running in the background'),
    smokeOpened: (site: string) => `Smoke on ${site} running in the background`,
    running: (n: number) => `${n} runs in progress`,
    seeProgress: 'See progress',
    resultSaved: 'Result saved to the dashboard',
    newRun: 'New run',
    editRun: 'Edit run',
    closeToast: 'Close notice',
    language: 'Language',
  },
} satisfies Record<Lang, unknown>;

type ToastKind = 'ok' | 'error' | 'info';
interface Toast { text: string; kind: ToastKind; id: number }

/** En la app de escritorio la cabecera hace de barra de título (se arrastra la ventana desde ella). */
const IS_DESKTOP = typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent);
if (IS_DESKTOP) document.documentElement.classList.add('desktop');

/** ¿El foco está en un campo de texto? Entonces las teclas sueltas no son atajos. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Formulario abierto: `id` presente = edición; ausente = registro nuevo. */
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
    ...overrides,
  };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [regressionOpen, setRegressionOpen] = useState(false);
  /** Ejecución cuyo reporte QA está abierto (se lee del estado para verlo actualizarse). */
  const [reportId, setReportId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dash');
  const [form, setForm] = useState<FormState | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const formKey = useRef(0);
  const lang: Lang = state?.settings.language ?? systemLang();
  const t = TEXT[lang];
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const notify = useCallback((text: string, kind: ToastKind = 'ok') => setToast({ text, kind, id: Date.now() }), []);
  const fail = useCallback((error: unknown) => notify(errorMessage(error), 'error'), [notify]);
  /** Aviso importante: toast y, si el sistema lo permite (la app de escritorio sí), notificación nativa. */
  const announce = useCallback(
    (title: string, body: string) => {
      notify(`${title}: ${body}`);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
      } catch {
        // Sin notificaciones del sistema basta con el toast.
      }
    },
    [notify],
  );

  // Los tickets de Jira se actualizan solos: cada pocos minutos y al volver a la ventana.
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

  // Mientras Claude corre una ejecución o se traducen reportes, se consulta el estado cada pocos segundos.
  const running = (state?.automations.some((a) => a.finishedAt === null) ?? false) || (state?.translating ?? 0) > 0;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api
        .getState()
        .then((next) => {
          const before = new Map(stateRef.current?.automations.map((a) => [a.id, a]));
          setState((s) => (s ? { ...s, runs: next.runs, automations: next.automations, translating: next.translating } : s));
          for (const a of next.automations) {
            if (a.finishedAt !== null && before.get(a.id)?.finishedAt === null) {
              const what =
                a.kind === 'smoke' ? `Smoke ${a.target}` : a.kind === 'orchestrator' ? a.target : `Regression ${a.target}`.trim();
              const current = stateRef.current?.settings.language ?? 'es';
              announce(`${what}: ${a.verdict}`, reportIn(a, current).summary || TEXT[current].resultSaved);
            }
          }
        })
        .catch(() => undefined);
    }, AUTOMATION_POLL_MS);
    return () => clearInterval(timer);
  }, [running, announce]);

  useEffect(() => {
    if (!toast) return;
    // Los errores se quedan más tiempo: hay que poder leerlos.
    const timer = setTimeout(() => setToast(null), toast.kind === 'error' ? 7000 : 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    api.getState().then(setState, (error: unknown) => setLoadError(errorMessage(error)));
  }, []);

  // Comandos del menú de la app de escritorio y atajos de teclado. Se guardan en una ref
  // para que el listener (registrado una sola vez) use siempre el estado actual.
  const commands = useRef<(command: string) => void>(() => undefined);
  useEffect(() => {
    const onCommand = (event: Event): void => commands.current((event as CustomEvent<string>).detail);
    const onKey = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]')) return;
      const mod = event.metaKey || event.ctrlKey;
      // En escritorio el menú ya atiende ⌘N, ⌘1… (no llegan aquí); en el navegador sí.
      if (mod && /^[123]$/.test(event.key)) {
        event.preventDefault();
        commands.current(`tab:${TABS[Number(event.key) - 1]!.id}`);
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

  const patch = (changes: Partial<AppState>): void => setState((s) => (s ? { ...s, ...changes } : s));
  const openForm = (initial: TestRunInput, id?: string): void => setForm({ key: ++formKey.current, id, initial });

  const saveRun = async (input: TestRunInput): Promise<boolean> => {
    try {
      const editingId = form?.id;
      const saved = editingId ? await api.updateRun(editingId, input) : await api.createRun(input);
      setState((s) =>
        s ? { ...s, runs: editingId ? s.runs.map((r) => (r.id === saved.id ? saved : r)) : [...s.runs, saved] } : s,
      );
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
      setState((s) => (s ? { ...s, runs: s.runs.filter((r) => r.id !== run.id) } : s));
      notify(t.deleted);
    } catch (error) {
      fail(error);
    }
  };

  const saveSettings = async (settings: Settings): Promise<void> => {
    const previous = state.settings;
    patch({ settings }); // Optimista: los ajustes responden al instante y se revierten si el guardado falla.
    try {
      const saved = await api.saveSettings(settings);
      if (saved.language !== previous.language) {
        // Al cambiar de idioma el servidor traduce tipos, títulos y notas, y empieza a traducir los reportes de Claude.
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
      // El servidor guardó el error de conexión: se recarga el estado para mostrarlo.
      api.getState().then((next) => patch({ jira: next.jira })).catch(() => undefined);
    } finally {
      setJiraLoading(false);
    }
  };

  /** Actualización automática: sin avisos salvo tickets nuevos en On QA / On Staging. */
  autoRefresh.current = () => {
    const { jira } = state;
    if (jiraLoading || !jira.hasToken || jira.connection === 'none') return;
    // Al volver a la ventana no se repite si la última carga es muy reciente.
    if (jira.fetchedAt !== null && Date.now() - jira.fetchedAt < 60_000) return;
    const known = new Set(jira.tickets.map((t) => t.key));
    setJiraLoading(true);
    api
      .refreshJira()
      .then((next) => {
        patch({ jira: next });
        const fresh = next.tickets.filter((t) => !known.has(t.key) && canOrchestrate(t.status));
        if (fresh.length === 1) announce(t.newTicketIn(fresh[0]!.status), `${fresh[0]!.key} · ${fresh[0]!.summary}`);
        else if (fresh.length > 1) announce(t.newTickets, fresh.map((t) => t.key).join(', '));
      })
      // El error queda en el estado de conexión de la tarjeta; no se interrumpe con un aviso.
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
      setState(next);
      notify(t.imported(next.runs.length));
    } catch (error) {
      fail(error);
    }
  };

  const newFromTicket = (ticket: JiraTicket): void => {
    const functional = state.settings.types.find((t) => /funcional|functional/i.test(t.name));
    openForm(blankRun(state.settings, { ticket: ticket.key, title: ticket.summary, ...(functional && { typeId: functional.id }) }));
  };

  /** Tras lanzar una ejecución, su registro «En progreso» ya está en Registros. */
  const reloadRuns = async (automation: Automation): Promise<void> => {
    const next = await api.getState().catch(() => null);
    if (next) patch({ runs: next.runs, automations: next.automations });
    else patch({ automations: [automation, ...state.automations] });
  };

  const runOrchestrator = async (ticket: JiraTicket): Promise<void> => {
    setLaunching(ticket.key);
    try {
      const automation = await api.runOrchestrator(ticket.key);
      await reloadRuns(automation);
      notify(t.orchestratorOpened(ticket.key), 'info');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLaunching(null);
    }
  };

  const runRegression = async (run: string): Promise<boolean> => {
    try {
      const automation = await api.runRegression(run);
      await reloadRuns(automation);
      notify(t.regressionOpened(run), 'info');
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    }
  };

  const runSmoke = async (site: SmokeSite): Promise<void> => {
    setLaunching(`smoke:${site}`);
    try {
      const automation = await api.runSmoke(site);
      await reloadRuns(automation);
      notify(t.smokeOpened(SMOKE_SITES[site].label), 'info');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLaunching(null);
    }
  };

  const dismissAutomation = async (automation: Automation): Promise<void> => {
    try {
      await api.deleteAutomation(automation.id);
      // Si no había terminado, su registro «En progreso» también se quitó.
      const next = await api.getState();
      patch({ runs: next.runs, automations: next.automations });
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const toInput = ({ id: _id, createdAt: _createdAt, ...input }: TestRun): TestRunInput => input;
  const newRun = (): void => openForm(blankRun(state.settings));

  commands.current = (command) => {
    if (command === 'new-run') {
      if (!form) newRun();
    } else if (command === 'refresh-jira') {
      if (!jiraLoading && state.jira.connection !== 'none') void refreshJira();
    } else if (command === 'search') {
      setTab('runs');
      setTimeout(() => document.getElementById('runs-search')?.focus(), 0);
    } else if (command.startsWith('tab:')) {
      setTab(command.slice(4) as Tab);
    }
  };

  const report = reportId ? state.automations.find((a) => a.id === reportId) : undefined;
  const active = state.automations.filter((a) => a.finishedAt === null);
  const stopAutomation = async (automation: Automation): Promise<void> => {
    try {
      await api.stopAutomation(automation.id);
      const next = await api.getState();
      patch({ runs: next.runs, automations: next.automations });
    } catch (err) {
      notify((err as Error).message, 'error');
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
        {active.length > 0 && (
          <button className="running-indicator" onClick={() => setReportId(active[0]!.id)} title={t.seeProgress}>
            <i className="run-dot" />
            {active.length === 1
              ? `Running · ${KIND_LABEL[lang][active[0]!.kind]} ${active[0]!.target} · ${elapsedMin(active[0]!)} min`
              : t.running(active.length)}
          </button>
        )}
        <div className="lang-switch" role="group" aria-label={t.language}>
          {LANGUAGES.map((l) => (
            <button key={l} className={l === lang ? 'on' : ''} aria-pressed={l === lang} onClick={() => setLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="btn primary" onClick={newRun} title={`${t.newRun} (${MOD}N)`}>
          <Icon name="plus" /> {t.newRun} <Kbd>{MOD}N</Kbd>
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
            onError={(message) => notify(message, 'error')}
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
      {regressionOpen && <RegressionDialog onLaunch={runRegression} onClose={() => setRegressionOpen(false)} />}
      {report && (
        <ReportDialog
          key={report.id}
          automation={report}
          run={state.runs.find((r) => r.id === report.runId)}
          onClose={() => setReportId(null)}
          onStop={stopAutomation}
          onUpdate={(updated) => patch({ automations: state.automations.map((a) => (a.id === updated.id ? updated : a)) })}
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
