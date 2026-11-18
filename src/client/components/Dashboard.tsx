import { useMemo, useState } from 'react';
import { RESULT_META } from '../../shared/defaults';
import { formatDmy, parseYmd, relativeDay, toYmd } from '../../shared/dates';
import {
  buildBuckets, countByTicket, countByType, filterByPeriod, lastRunByType, sortRuns, summarize,
  type Bucket, type Period, type ResultCounts,
} from '../../shared/stats';
import { parseJiraBoardUrl } from '../../shared/jiraBoard';
import { RESULTS, type AppState, type JiraConnection, type JiraTicket } from '../../shared/types';
import { findType, ResultPill, RunsTable } from './ui';

const PERIODS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: 7, label: '7 días' },
  { value: 30, label: '30 días' },
  { value: 90, label: '90 días' },
  { value: 0, label: 'Todo' },
];

interface DashboardProps {
  state: AppState;
  jiraLoading: boolean;
  onRefreshJira: () => void;
  onTicket: (ticket: JiraTicket) => void;
}

const JIRA_STATUS: Record<JiraConnection, { label: string; color: string }> = {
  none: { label: 'No conectado', color: 'var(--muted)' },
  pending: { label: 'Sin probar', color: 'var(--warn)' },
  connected: { label: 'Conectado', color: 'var(--ok)' },
  error: { label: 'Error de conexión', color: 'var(--bad)' },
};

/** Indicador del estado de la conexión con Jira, con el sitio y el board como detalle. */
function JiraStatus({ jira, loading }: { jira: AppState['jira']; loading: boolean }) {
  const meta = loading ? { label: 'Conectando…', color: 'var(--prog)' } : JIRA_STATUS[jira.connection];
  const board = parseJiraBoardUrl(jira.board);
  const where = jira.site ? `${jira.site.replace(/^https?:\/\//, '')}${board ? ` · board ${board.boardId}` : ''}` : '';
  return (
    <span className="jira-status" role="status" title={jira.connection === 'error' ? jira.error ?? '' : where}>
      <i style={{ background: meta.color }} />
      {meta.label}
      {where && jira.connection !== 'none' ? <span className="hint"> · {where}</span> : null}
    </span>
  );
}

/** Segmentos apilados por resultado; se usa en ambos gráficos. */
function Segments({ counts }: { counts: ResultCounts }) {
  return (
    <>
      {RESULTS.filter((r) => counts[r] > 0).map((r) => (
        <i key={r} style={{ flex: counts[r], background: RESULT_META[r].color }} title={`${RESULT_META[r].label}: ${counts[r]}`} />
      ))}
    </>
  );
}

function ActivityChart({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const labelEvery = Math.ceil(buckets.length / 10);
  return (
    <>
      <div className="chart">
        {buckets.map((b) => (
          <div key={b.from} className={b.total ? 'col' : 'col empty'} title={`${b.label}: ${b.total} ejecuciones`}>
            <div className="stack" style={b.total ? { height: `${Math.max(4, (b.total / max) * 100)}%` } : undefined}>
              <Segments counts={b.counts} />
            </div>
          </div>
        ))}
      </div>
      <div className="xlab">
        {buckets.map((b, i) => (
          <span key={b.from}>{(buckets.length - 1 - i) % labelEvery === 0 ? b.label : ''}</span>
        ))}
      </div>
      <div className="legend">
        {RESULTS.map((r) => (
          <span key={r}>
            <span className="dot" style={{ background: RESULT_META[r].color }} />
            {RESULT_META[r].label}
          </span>
        ))}
      </div>
    </>
  );
}

export function Dashboard({ state, jiraLoading, onRefreshJira, onTicket }: DashboardProps) {
  const [period, setPeriod] = useState<Period>(30);
  const { settings, runs, jira } = state;
  // Se memoriza por valor para que las estadísticas solo se recalculen al cambiar de día.
  const todayYmd = toYmd(new Date());
  const today = useMemo(() => parseYmd(todayYmd), [todayYmd]);

  const view = useMemo(() => {
    const inPeriod = filterByPeriod(runs, period, today);
    return {
      inPeriod,
      summary: summarize(inPeriod),
      buckets: buildBuckets(runs, period, today),
      byType: countByType(inPeriod),
      lastByType: lastRunByType(runs),
      perTicket: countByTicket(runs),
      recent: sortRuns(runs).slice(0, 8),
      todayCount: runs.filter((r) => r.date === todayYmd).length,
    };
  }, [runs, period, today, todayYmd]);

  const { summary } = view;
  const kpis: Array<[label: string, value: string | number, sub: string]> = [
    ['Ejecuciones', summary.executions, `${view.todayCount} hoy`],
    ['Casos ejecutados', summary.cases, `${summary.failed} failed · ${summary.blocked} blocked`],
    [
      'Pass rate',
      summary.passRate === null ? '—' : `${summary.passRate}%`,
      summary.passRateBasis === 'none'
        ? 'sin datos'
        : `${summary.passNumerator} de ${summary.passDenominator} ${summary.passRateBasis === 'cases' ? 'casos' : 'ejecuciones'}`,
    ],
    ['Bugs encontrados', summary.bugs, ''],
    ['Tiempo', `${(summary.minutes / 60).toFixed(1)} h`, `${summary.minutes} min`],
  ];
  const maxByType = view.byType[0]?.total ?? 1;
  const daily = period === 7 || period === 30;

  return (
    <section>
      <div className="row">
        <h2>Resumen</h2>
        <div className="spacer" />
        <div className="seg">
          {PERIODS.map((p) => (
            <button key={p.value} className={p.value === period ? 'on' : ''} onClick={() => setPeriod(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        {kpis.map(([label, value, sub]) => (
          <div key={label} className="card kpi">
            <div className="lbl">{label}</div>
            <div className="val">{value}</div>
            <div className="sub">{sub || ' '}</div>
          </div>
        ))}
      </div>

      <div className="majors">
        {settings.types.filter((t) => t.major).map((type) => {
          const last = view.lastByType.get(type.id);
          return (
            <div key={type.id} className="card major" style={{ borderLeftColor: type.color }}>
              <div className="name"><span className="star">★</span> {type.name}</div>
              {last ? (
                <>
                  <div style={{ marginTop: 8 }}>
                    <ResultPill result={last.result} /> <span className="hint">{last.env}</span>
                  </div>
                  <div className="meta">
                    Última: {formatDmy(last.date)} ({relativeDay(last.date, today)})<br />
                    {last.title}
                  </div>
                </>
              ) : (
                <div className="meta" style={{ marginTop: 8 }}>Sin ejecuciones registradas</div>
              )}
              <div className="meta">{view.inPeriod.filter((r) => r.typeId === type.id).length} en el período</div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Tickets de Jira</h3>
          <JiraStatus jira={jira} loading={jiraLoading} />
          {jira.connection === 'connected' && jira.fetchedAt !== null && (
            <span className="hint">
              {jira.tickets.length} tickets · actualizado {new Date(jira.fetchedAt).toLocaleString()}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onRefreshJira} disabled={jiraLoading}>
            {jiraLoading ? 'Cargando…' : 'Actualizar desde Jira'}
          </button>
        </div>
        <div className="tickets">
          {jira.tickets.length === 0 ? (
            <div className="empty-msg" style={{ gridColumn: '1 / -1' }}>
              {jira.connection === 'none'
                ? 'Conecta Jira en “Tipos y ajustes” para ver aquí tus tickets como botones.'
                : jira.connection === 'error'
                  ? `No se pudo conectar con Jira: ${jira.error ?? ''} Revisa la conexión en “Tipos y ajustes”.`
                  : jira.connection === 'connected'
                    ? 'Jira está conectado, pero no hay tickets abiertos que coincidan con el filtro.'
                    : 'Pulsa “Actualizar desde Jira” para cargar tus tickets.'}
            </div>
          ) : (
            jira.tickets.map((ticket) => {
              const logged = view.perTicket.get(ticket.key);
              return (
                <button
                  key={ticket.key}
                  className="tk"
                  title={`Registrar un test para ${ticket.key} — ${ticket.summary}`}
                  onClick={() => onTicket(ticket)}
                >
                  <span className="st">{ticket.status}</span>
                  <b>{ticket.key}</b>
                  {logged ? <span className="hint"> · {logged} reg.</span> : null}
                  <span className="sm">{ticket.summary}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Actividad {daily ? 'por día' : `por semana (últimas ${view.buckets.length})`}</h3>
          <ActivityChart buckets={view.buckets} />
        </div>
        <div className="card">
          <h3>Por tipo de test</h3>
          {view.byType.length === 0 ? (
            <div className="empty-msg">Sin ejecuciones en el período.</div>
          ) : (
            view.byType.map((entry) => {
              const type = findType(settings, entry.typeId);
              return (
                <div key={entry.typeId} className="hbar">
                  <div className="nm" title={type.name}>
                    {type.major && <span className="star">★ </span>}
                    {type.name}
                  </div>
                  <div className="track">
                    <div style={{ display: 'flex', width: `${(entry.total / maxByType) * 100}%` }}>
                      <Segments counts={entry.counts} />
                    </div>
                  </div>
                  <div className="n">{entry.total}</div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="card">
        <h3>Últimos registros</h3>
        <div className="tablewrap">
          <RunsTable runs={view.recent} settings={settings} />
        </div>
      </div>
    </section>
  );
}
