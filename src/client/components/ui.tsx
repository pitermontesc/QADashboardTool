import { RESULT_META, resultLabel } from '../../shared/defaults';
import { formatDmy } from '../../shared/dates';
import { parseJiraBoardUrl } from '../../shared/jiraBoard';
import type { JiraConnection, JiraState, Result, Settings, TestRun, TestType } from '../../shared/types';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { useLang, useText } from '../i18n';

export function findType(settings: Settings, id: string): TestType {
  const unknown = settings.language === 'en' ? '(deleted type)' : '(tipo eliminado)';
  return settings.types.find((t) => t.id === id) ?? { id: '', name: unknown, major: false, color: '#888888' };
}

export function ResultPill({ result }: { result: Result }) {
  const { color } = RESULT_META[result];
  const label = resultLabel(result, useLang());
  return (
    <span className="pill" style={{ color, border: `1px solid ${color}` }}>
      {label}
    </span>
  );
}

export function TypeTag({ type }: { type: TestType }) {
  return (
    <span className="tag" style={{ color: type.color }}>
      {type.major && <span className="star">★ </span>}
      {type.name}
    </span>
  );
}

export function TicketLink({ ticket, base }: { ticket: string; base: string }) {
  const title = useText({ es: 'Abrir en Jira', en: 'Open in Jira' });
  if (!ticket) return null;
  if (!/^https?:\/\//i.test(base)) return <>{ticket}</>;
  return (
    <a className="ticket-link" href={base + encodeURIComponent(ticket)} target="_blank" rel="noopener noreferrer" title={title}>
      {ticket}
    </a>
  );
}

function Cases({ run }: { run: TestRun }) {
  if (run.passed === null && run.failed === null && run.blocked === null) return <span className="hint">—</span>;
  return (
    <>
      <span style={{ color: 'var(--ok)' }}>{run.passed ?? 0}</span> /{' '}
      <span style={{ color: 'var(--bad)' }}>{run.failed ?? 0}</span> /{' '}
      <span style={{ color: 'var(--warn)' }}>{run.blocked ?? 0}</span>
    </>
  );
}

interface RunsTableProps {
  runs: TestRun[];
  settings: Settings;
  /** Celda de acciones por fila; si se omite la tabla es de solo lectura. */
  actions?: (run: TestRun) => ReactNode;
}

const TABLE_TEXT = {
  es: {
    empty: 'No hay registros todavía. Pulsa un ticket de Jira o “Nuevo registro” para empezar.',
    head: ['Fecha', 'Tipo', 'Título', 'Ticket', 'Amb.', 'Resultado', 'Casos P/F/B', 'Bugs', 'Min'],
  },
  en: {
    empty: 'No runs yet. Click a Jira ticket or “New run” to get started.',
    head: ['Date', 'Type', 'Title', 'Ticket', 'Env.', 'Result', 'Cases P/F/B', 'Bugs', 'Min'],
  },
};

export function RunsTable({ runs, settings, actions }: RunsTableProps) {
  const lang = useLang();
  const t = TABLE_TEXT[lang];
  if (runs.length === 0) {
    return <div className="empty-msg">{t.empty}</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          {t.head.map((label, i) => (
            <th key={label} title={i === 6 ? 'passed / failed / blocked' : undefined}>{label}</th>
          ))}
          {actions && <th />}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td className="num">{formatDmy(run.date, lang)}</td>
            <td><TypeTag type={findType(settings, run.typeId)} /></td>
            <td>
              {run.title}
              {run.notes && <div className="notes">{run.notes}</div>}
            </td>
            <td className="num"><TicketLink ticket={run.ticket} base={settings.ticketBase} /></td>
            <td>{run.env}</td>
            <td><ResultPill result={run.result} /></td>
            <td className="num"><Cases run={run} /></td>
            <td className="num">{run.bugs || ''}</td>
            <td className="num">{run.minutes || ''}</td>
            {actions && <td className="num">{actions(run)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const JIRA_TONE: Record<JiraConnection, string> = { none: 'muted', pending: 'warn', connected: 'ok', error: 'bad' };
const JIRA_TEXT = {
  es: { none: 'No conectado', pending: 'Sin probar', connected: 'Conectado', error: 'Error de conexión', loading: 'Conectando…' },
  en: { none: 'Not connected', pending: 'Not tested', connected: 'Connected', error: 'Connection error', loading: 'Connecting…' },
};

/** Indicador del estado de la conexión con Jira, con el sitio y el board como detalle. */
export function JiraStatus({ jira, loading, detail = true }: { jira: JiraState; loading: boolean; detail?: boolean }) {
  const t = JIRA_TEXT[useLang()];
  const meta = loading ? { label: t.loading, tone: 'prog' } : { label: t[jira.connection], tone: JIRA_TONE[jira.connection] };
  const board = parseJiraBoardUrl(jira.board);
  const where = jira.site ? `${jira.site.replace(/^https?:\/\//, '').replace(/\.atlassian\.net$/, '')}${board ? ` · board ${board.boardId}` : ''}` : '';
  return (
    <span className={`status-pill tone-${meta.tone}${loading ? ' pulsing' : ''}`} role="status" title={jira.connection === 'error' ? jira.error ?? '' : where}>
      <i />
      {meta.label}
      {detail && where && jira.connection !== 'none' ? <span className="status-detail">{where}</span> : null}
    </span>
  );
}

/** Tono de color para el estado de un ticket de Jira según su nombre. */
export function ticketTone(status: string): string {
  const s = status.toLowerCase();
  if (/stag/.test(s)) return 'stage';
  if (/qa|test/.test(s) && !/passed/.test(s)) return 'prog';
  if (/passed|done|closed|resuel/.test(s)) return 'ok';
  if (/block/.test(s)) return 'bad';
  return 'muted';
}

/** Atajo de teclado mostrado como teclas (⌘N). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';

export { Icon };
