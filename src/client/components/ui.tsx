import { RESULT_META } from '../../shared/defaults';
import { formatDmy } from '../../shared/dates';
import type { Result, Settings, TestRun, TestType } from '../../shared/types';
import type { ReactNode } from 'react';

const UNKNOWN_TYPE: TestType = { id: '', name: '(tipo eliminado)', major: false, color: '#888888' };

export function findType(settings: Settings, id: string): TestType {
  return settings.types.find((t) => t.id === id) ?? UNKNOWN_TYPE;
}

export function ResultPill({ result }: { result: Result }) {
  const { label, color } = RESULT_META[result];
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
  if (!ticket) return null;
  if (!/^https?:\/\//i.test(base)) return <>{ticket}</>;
  return (
    <a href={base + encodeURIComponent(ticket)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
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

export function RunsTable({ runs, settings, actions }: RunsTableProps) {
  if (runs.length === 0) {
    return <div className="empty-msg">No hay registros. Usa “+ Nuevo registro” o pulsa un ticket de Jira para empezar.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Fecha</th><th>Tipo</th><th>Título</th><th>Ticket</th><th>Amb.</th><th>Resultado</th>
          <th title="passed / failed / blocked">Casos P/F/B</th><th>Bugs</th><th>Min</th>
          {actions && <th />}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td className="num">{formatDmy(run.date)}</td>
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
