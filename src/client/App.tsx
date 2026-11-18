import { useCallback, useEffect, useRef, useState } from 'react';
import { toYmd } from '../shared/dates';
import type {
  AppState, Backup, JiraConfigInput, JiraTicket, Settings, TestRun, TestRunInput,
} from '../shared/types';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { SMOKE_SITES, canOrchestrate, type SmokeSite } from '../shared/orchestrator';
import { JIRA_AUTO_REFRESH_MIN } from './components/Dashboard';
import { RegressionDialog } from './components/RegressionDialog';
import { RunForm } from './components/RunForm';
import { RunsView } from './components/RunsView';
import { SettingsView } from './components/SettingsView';
import { Icon, type IconName } from './components/icons';
import { Kbd, MOD } from './components/ui';

type Tab = 'dash' | 'runs' | 'config';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: IconName; key: string }> = [
  { id: 'dash', label: 'Dashboard', icon: 'dashboard', key: '1' },
  { id: 'runs', label: 'Registros', icon: 'list', key: '2' },
  { id: 'config', label: 'Tipos y ajustes', icon: 'settings', key: '3' },
];

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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Error inesperado');

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
  const [tab, setTab] = useState<Tab>('dash');
  const [form, setForm] = useState<FormState | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const formKey = useRef(0);

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
          <p className="text-bad">No se pudo abrir la app: {loadError}</p>
          <button className="btn" onClick={() => location.reload()}>Reintentar</button>
        </div>
      </main>
    );
  }
  if (!state) return <main><div className="loading"><span className="spinner" /> Cargando…</div></main>;

  const patch = (changes: Partial<AppState>): void => setState((s) => (s ? { ...s, ...changes } : s));
  const openForm = (initial: TestRunInput, id?: string): void => setForm({ key: ++formKey.current, id, initial });

  const saveRun = async (input: TestRunInput): Promise<boolean> => {
    try {
      const editingId = form?.id;
      const saved = editingId ? await api.updateRun(editingId, input) : await api.createRun(input);
      setState((s) =>
        s ? { ...s, runs: editingId ? s.runs.map((r) => (r.id === saved.id ? saved : r)) : [...s.runs, saved] } : s,
      );
      notify('Registro guardado');
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
      notify('Registro borrado');
    } catch (error) {
      fail(error);
    }
  };

  const saveSettings = async (settings: Settings): Promise<void> => {
    const previous = state.settings;
    patch({ settings }); // Optimista: los ajustes responden al instante y se revierten si el guardado falla.
    try {
      patch({ settings: await api.saveSettings(settings) });
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
        notify(`${jira.tickets.length} tickets cargados`);
      } else {
        announce('Jira conectado', `${jira.tickets.length} tickets cargados desde ${jira.site.replace(/^https?:\/\//, '')}`);
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
        if (fresh.length === 1) announce(`Nuevo ticket en ${fresh[0]!.status}`, `${fresh[0]!.key} · ${fresh[0]!.summary}`);
        else if (fresh.length > 1) announce('Nuevos tickets por probar', fresh.map((t) => t.key).join(', '));
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
      notify(`Respaldo importado: ${next.runs.length} registros`);
    } catch (error) {
      fail(error);
    }
  };

  const newFromTicket = (ticket: JiraTicket): void => {
    const functional = state.settings.types.find((t) => /funcional/i.test(t.name));
    openForm(blankRun(state.settings, { ticket: ticket.key, title: ticket.summary, ...(functional && { typeId: functional.id }) }));
  };

  const runOrchestrator = async (ticket: JiraTicket): Promise<void> => {
    setLaunching(ticket.key);
    try {
      await api.runOrchestrator(ticket.key);
      notify(`Orquestador QA abierto en Terminal para ${ticket.key}`, 'info');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLaunching(null);
    }
  };

  const runRegression = async (run: string): Promise<boolean> => {
    try {
      await api.runRegression(run);
      notify(run ? `Regresión abierta en Terminal para ${run}` : 'Regresión abierta en Terminal', 'info');
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    }
  };

  const runSmoke = async (site: SmokeSite): Promise<void> => {
    setLaunching(`smoke:${site}`);
    try {
      await api.runSmoke(site);
      notify(`Smoke en ${SMOKE_SITES[site].label} abierto en Terminal`, 'info');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLaunching(null);
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

  return (
    <>
      <header>
        <div className="brand">
          <span className="logo" aria-hidden="true"><Icon name="check" size={14} /></span>
          <h1>QA <span>Dashboard</span></h1>
        </div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'on' : ''}
              aria-current={t.id === tab ? 'page' : undefined}
              title={`${MOD}${t.key}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn primary" onClick={newRun} title={`Nuevo registro (${MOD}N)`}>
          <Icon name="plus" /> Nuevo registro <Kbd>{MOD}N</Kbd>
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
          heading={form.id ? 'Editar registro' : 'Nuevo registro'}
          initial={form.initial}
          settings={state.settings}
          onSubmit={saveRun}
          onClose={() => setForm(null)}
        />
      )}
      {regressionOpen && <RegressionDialog onLaunch={runRegression} onClose={() => setRegressionOpen(false)} />}
      <div className={`toast${toast ? ` on ${toast.kind}` : ''}`} role={toast?.kind === 'error' ? 'alert' : 'status'}>
        {toast && (
          <>
            <Icon name={toast.kind === 'error' ? 'alert' : 'check'} />
            <span>{toast.text}</span>
            <button className="toast-close" aria-label="Cerrar aviso" onClick={() => setToast(null)}>
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </div>
    </>
  );
}
