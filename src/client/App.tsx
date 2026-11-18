import { useCallback, useEffect, useRef, useState } from 'react';
import { toYmd } from '../shared/dates';
import type {
  AppState, Backup, JiraConfigInput, JiraTicket, Settings, TestRun, TestRunInput,
} from '../shared/types';
import { api } from './api';
import { Dashboard } from './components/Dashboard';
import { RunForm } from './components/RunForm';
import { RunsView } from './components/RunsView';
import { SettingsView } from './components/SettingsView';

type Tab = 'dash' | 'runs' | 'config';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'dash', label: 'Dashboard' },
  { id: 'runs', label: 'Registros' },
  { id: 'config', label: 'Tipos y ajustes' },
];

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
  const [tab, setTab] = useState<Tab>('dash');
  const [form, setForm] = useState<FormState | null>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const formKey = useRef(0);

  const notify = useCallback((text: string) => setToast({ text, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    api.getState().then(setState, (error: unknown) => setLoadError(errorMessage(error)));
  }, []);

  if (loadError) return <main><div className="empty-msg">{loadError}</div></main>;
  if (!state) return <main><div className="empty-msg">Cargando…</div></main>;

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
      notify(errorMessage(error));
      return false;
    }
  };

  const deleteRun = async (run: TestRun): Promise<void> => {
    try {
      await api.deleteRun(run.id);
      setState((s) => (s ? { ...s, runs: s.runs.filter((r) => r.id !== run.id) } : s));
      notify('Registro borrado');
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const saveSettings = async (settings: Settings): Promise<void> => {
    const previous = state.settings;
    patch({ settings }); // Optimista: los ajustes responden al instante y se revierten si el guardado falla.
    try {
      patch({ settings: await api.saveSettings(settings) });
    } catch (error) {
      patch({ settings: previous });
      notify(errorMessage(error));
    }
  };

  const refreshJira = async (): Promise<void> => {
    setJiraLoading(true);
    try {
      const jira = await api.refreshJira();
      patch({ jira });
      notify(`${jira.tickets.length} tickets cargados`);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setJiraLoading(false);
    }
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
      notify(errorMessage(error));
    }
  };

  const importBackup = async (backup: Backup): Promise<void> => {
    try {
      const next = await api.importBackup(backup);
      setState(next);
      notify(`Respaldo importado: ${next.runs.length} registros`);
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const newFromTicket = (ticket: JiraTicket): void => {
    const functional = state.settings.types.find((t) => /funcional/i.test(t.name));
    openForm(blankRun(state.settings, { ticket: ticket.key, title: ticket.summary, ...(functional && { typeId: functional.id }) }));
  };

  const toInput = ({ id: _id, createdAt: _createdAt, ...input }: TestRun): TestRunInput => input;

  return (
    <>
      <header>
        <h1>QA <span>Test Dashboard</span></h1>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn primary" onClick={() => openForm(blankRun(state.settings))}>+ Nuevo registro</button>
      </header>

      <main>
        {tab === 'dash' && (
          <Dashboard state={state} jiraLoading={jiraLoading} onRefreshJira={refreshJira} onTicket={newFromTicket} />
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
          <SettingsView state={state} onSaveSettings={saveSettings} onSaveJira={saveJira} onImport={importBackup} onError={notify} />
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
      <div className={toast ? 'toast on' : 'toast'} role="status">{toast?.text}</div>
    </>
  );
}
