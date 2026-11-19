import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AppState, AssistantAction, AssistantTurn } from '../../shared/types';
import { findSite } from '../../shared/orchestrator';
import { Icon } from './icons';
import { useText } from '../i18n';
import { MOD } from './ui';

/** Estado de cada acción propuesta: espera confirmación, se está haciendo o ya se resolvió. */
type ActionState = 'pending' | 'running' | 'done' | 'failed' | 'dismissed';

export interface ChatMessage extends AssistantTurn {
  actions?: { action: AssistantAction; state: ActionState }[];
  error?: boolean;
}

interface AssistantPanelProps {
  state: AppState;
  messages: ChatMessage[];
  setMessages: (update: (messages: ChatMessage[]) => ChatMessage[]) => void;
  onClose: () => void;
  /** Hace la acción con la misma lógica que los botones de la app; true si salió bien. */
  onAction: (action: AssistantAction) => Promise<boolean>;
}

const TEXT = {
  es: {
    title: 'Asistente', sub: 'Claude con tus datos de QA', close: 'Cerrar el asistente', clear: 'Nueva conversación',
    placeholder: 'Pregunta o pide algo…', send: 'Enviar', thinking: 'Pensando…',
    hint: (mod: string) => `Enter envía · Shift+Enter salto de línea · ${mod}K abre y cierra`,
    empty: 'Pregunta por tus registros, reportes y tickets, o pídele que lance algo. Lo que lance o publique te lo pide confirmar antes.',
    suggestions: ['¿Qué falló esta semana?', 'Resume el último reporte', '¿Qué tickets me faltan por probar?', 'Lanza el smoke en STG'],
    confirm: 'Confirmar', dismiss: 'Descartar', open: 'Abrir', done: 'Hecho', failed: 'No se pudo', dismissed: 'Descartada', running: 'En curso…',
    retry: 'Reintentar', demo: 'En la demo el asistente está simulado: responde a unas pocas peticiones con los datos de ejemplo.',
    action: (a: AssistantAction, state: AppState): string => {
      switch (a.type) {
        case 'run_smoke': return `Lanzar el smoke en ${findSite(a.site, state.settings.qa)?.name ?? a.site}`;
        case 'run_regression': return `Lanzar la regresión${a.run ? ` ${a.run}` : ''}`;
        case 'run_orchestrator': return `Ejecutar el orquestador QA en ${a.key}`;
        case 'create_run': return `Crear el registro «${a.run.title}» (${a.run.result}${a.run.ticket ? `, ${a.run.ticket}` : ''})`;
        case 'post_jira_comment': return `Publicar el comentario de QA en ${commentKey(a.automationId, state)}`;
        case 'open_report': return `Abrir el reporte QA de ${what(a.automationId, state)}`;
      }
    },
  },
  en: {
    title: 'Assistant', sub: 'Claude with your QA data', close: 'Close the assistant', clear: 'New conversation',
    placeholder: 'Ask or request something…', send: 'Send', thinking: 'Thinking…',
    hint: (mod: string) => `Enter sends · Shift+Enter new line · ${mod}K opens and closes`,
    empty: 'Ask about your runs, reports and tickets, or ask it to launch something. Anything it launches or posts asks for your confirmation first.',
    suggestions: ['What failed this week?', 'Summarize the latest report', 'Which tickets do I still need to test?', 'Launch the smoke test on STG'],
    confirm: 'Confirm', dismiss: 'Dismiss', open: 'Open', done: 'Done', failed: 'Failed', dismissed: 'Dismissed', running: 'Running…',
    retry: 'Retry', demo: 'In the demo the assistant is simulated: it answers a few requests with the sample data.',
    action: (a: AssistantAction, state: AppState): string => {
      switch (a.type) {
        case 'run_smoke': return `Launch the smoke test on ${findSite(a.site, state.settings.qa)?.name ?? a.site}`;
        case 'run_regression': return `Launch the regression${a.run ? ` ${a.run}` : ''}`;
        case 'run_orchestrator': return `Run the QA orchestrator on ${a.key}`;
        case 'create_run': return `Create the run “${a.run.title}” (${a.run.result}${a.run.ticket ? `, ${a.run.ticket}` : ''})`;
        case 'post_jira_comment': return `Post the QA comment on ${commentKey(a.automationId, state)}`;
        case 'open_report': return `Open the QA report of ${what(a.automationId, state)}`;
      }
    },
  },
};

const commentKey = (id: string, state: AppState): string =>
  state.automations.find((a) => a.id === id)?.details?.jiraComment?.key ?? 'Jira';
const what = (id: string, state: AppState): string => {
  const a = state.automations.find((x) => x.id === id);
  return a ? `${a.kind === 'orchestrator' ? '' : `${a.kind} `}${a.target}`.trim() : '—';
};

/** Markdown mínimo del asistente: párrafos, listas con guiones y **negrita**, sin HTML. */
function RichText({ text }: { text: string }) {
  const inline = (line: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>,
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[1]!);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

export function AssistantPanel({ state, messages, setMessages, onClose, onAction }: AssistantPanelProps) {
  const t = useText(TEXT);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async (text: string): Promise<void> => {
    const question = text.trim();
    if (!question || busy) return;
    const history: AssistantTurn[] = [
      ...messages.filter((m) => !m.error).map(({ role, text: body }) => ({ role, text: body })),
      { role: 'user' as const, text: question },
    ].slice(-40);
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setDraft('');
    setBusy(true);
    try {
      const reply = await api.askAssistant(history);
      setMessages((m) => [...m, { role: 'assistant', text: reply.reply, actions: reply.actions.map((action) => ({ action, state: 'pending' })) }]);
    } catch (error) {
      setMessages((m) => [...m, { role: 'assistant', text: error instanceof Error ? error.message : String(error), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const setActionState = (msg: number, idx: number, next: ActionState): void =>
    setMessages((m) => m.map((message, i) => (i !== msg || !message.actions ? message : { ...message, actions: message.actions.map((a, j) => (j === idx ? { ...a, state: next } : a)) })));

  const run = async (msg: number, idx: number, action: AssistantAction): Promise<void> => {
    setActionState(msg, idx, 'running');
    setActionState(msg, idx, (await onAction(action)) ? 'done' : 'failed');
  };

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  return (
    <aside className="assistant" aria-label={t.title}>
      <div className="assistant-head">
        <Icon name="sparkle" />
        <div>
          <h2>{t.title}</h2>
          <span className="hint">{t.sub}</span>
        </div>
        <div className="spacer" />
        {messages.length > 0 && (
          <button className="icon-btn" title={t.clear} aria-label={t.clear} onClick={() => setMessages(() => [])} disabled={busy}>
            <Icon name="refresh" />
          </button>
        )}
        <button className="icon-btn" title={t.close} aria-label={t.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <div className="assistant-list" ref={list} aria-live="polite">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p>{t.empty}</p>
            {state.demo && <p className="hint">{t.demo}</p>}
            <div className="assistant-suggestions">
              {t.suggestions.map((s) => (
                <button key={s} className="btn small" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`assistant-msg from-${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? <RichText text={m.text} /> : <p>{m.text}</p>}
            {m.error && lastUser && i === messages.length - 1 && (
              <button className="link-btn" onClick={() => { setMessages((all) => all.slice(0, -2)); void send(lastUser.text); }}>{t.retry}</button>
            )}
            {m.actions?.map(({ action, state: s }, j) => (
              <div key={j} className={`assistant-action is-${s}`}>
                <span>{t.action(action, state)}</span>
                {s === 'pending' ? (
                  <span className="assistant-action-btns">
                    {action.type !== 'open_report' && (
                      <button className="btn small" onClick={() => setActionState(i, j, 'dismissed')}>{t.dismiss}</button>
                    )}
                    <button className="btn small primary" onClick={() => void run(i, j, action)}>
                      {action.type === 'open_report' ? t.open : t.confirm}
                    </button>
                  </span>
                ) : (
                  <span className="hint">{s === 'running' ? t.running : s === 'done' ? t.done : s === 'failed' ? t.failed : t.dismissed}</span>
                )}
              </div>
            ))}
          </div>
        ))}
        {busy && (
          <div className="assistant-msg from-assistant thinking">
            <span className="spinner" /> {t.thinking}
          </div>
        )}
      </div>

      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={input}
          aria-label={t.placeholder}
          placeholder={t.placeholder}
          value={draft}
          rows={2}
          maxLength={8000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button className="btn primary" type="submit" disabled={busy || !draft.trim()} aria-label={t.send} title={t.send}>
          <Icon name="arrow" />
        </button>
      </form>
      <p className="hint assistant-hint">{t.hint(MOD)}</p>
    </aside>
  );
}
