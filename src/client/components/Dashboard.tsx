import { useMemo, useState, type ReactNode } from 'react';
import { RESULT_META } from '../../shared/defaults';
import { formatDmy, greeting, longDate, parseYmd, relativeDay, relativeTime, toYmd } from '../../shared/dates';
import {
  buildBuckets, countByTicket, countByType, filterByPeriod, lastRunByType, sortRuns, summarize,
  type Bucket, type Period, type ResultCounts,
} from '../../shared/stats';
import { ORCHESTRATOR_SKILL, SMOKE_SITES, canOrchestrate, isRegressionType, isSmokeType, type SmokeSite } from '../../shared/orchestrator';
import { RESULTS, type AppState, type Automation, type JiraTicket } from '../../shared/types';
import { Automations } from './Automations';
import { Icon } from './icons';
import { findType, JiraStatus, MOD, ResultPill, RunsTable, ticketTone } from './ui';

const PERIODS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: 7, label: '7 días' },
  { value: 30, label: '30 días' },
  { value: 90, label: '90 días' },
  { value: 0, label: 'Todo' },
];

/** A partir de cuántos tickets aparece el buscador de la sección. */
const TICKET_SEARCH_FROM = 7;
/** Cada cuántos minutos se actualizan solos los tickets de Jira. */
export const JIRA_AUTO_REFRESH_MIN = 5;

interface DashboardProps {
  state: AppState;
  jiraLoading: boolean;
  onRefreshJira: () => void;
  onTicket: (ticket: JiraTicket) => void;
  onOrchestrate: (ticket: JiraTicket) => void;
  /** Ticket cuyo orquestador se está abriendo. */
  launching: string | null;
  onRegression: () => void;
  onSmoke: (site: SmokeSite) => void;
  onDismissAutomation: (automation: Automation) => void;
  onNewRun: () => void;
  onOpenSettings: () => void;
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

interface TicketsProps {
  jira: AppState['jira'];
  loading: boolean;
  ticketBase: string;
  perTicket: Map<string, number>;
  onRefresh: () => void;
  onTicket: (ticket: JiraTicket) => void;
  onOrchestrate: (ticket: JiraTicket) => void;
  launching: string | null;
  onOpenSettings: () => void;
}

/** Tickets de Jira como tarjetas: el punto de partida habitual para registrar un test. */
function JiraTickets({ jira, loading, ticketBase, perTicket, onRefresh, onTicket, onOrchestrate, launching, onOpenSettings }: TicketsProps) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const tickets = q
    ? jira.tickets.filter((t) => `${t.key} ${t.summary} ${t.status}`.toLowerCase().includes(q))
    : jira.tickets;
  const base = /^https?:\/\//i.test(ticketBase) ? ticketBase : jira.site ? `${jira.site}/browse/` : '';

  let empty: ReactNode = null;
  if (jira.tickets.length === 0) {
    empty =
      jira.connection === 'none' ? (
        <>
          <p>Conecta Jira para ver aquí los tickets que tienes que probar y registrarlos con un clic.</p>
          <button className="btn primary" onClick={onOpenSettings}>Conectar Jira</button>
        </>
      ) : jira.connection === 'error' ? (
        <>
          <p className="text-bad">No se pudo conectar con Jira: {jira.error}</p>
          <div className="btn-row">
            <button className="btn" onClick={onRefresh} disabled={loading}>Reintentar</button>
            <button className="btn" onClick={onOpenSettings}>Revisar conexión</button>
          </div>
        </>
      ) : jira.connection === 'connected' ? (
        <p>Todo al día: no hay tickets pendientes de probar con tu filtro. 🎉</p>
      ) : (
        <>
          <p>La conexión está configurada. Carga los tickets para empezar.</p>
          <button className="btn primary" onClick={onRefresh} disabled={loading}>Cargar tickets</button>
        </>
      );
  }

  return (
    <div className="card section-tickets">
      <div className="card-head">
        <div>
          <h3 className="title">Tickets por probar</h3>
          <div className="card-sub">
            <JiraStatus jira={jira} loading={loading} />
            {jira.connection === 'connected' && jira.fetchedAt !== null && (
              <span className="hint">
                {jira.tickets.length} {jira.tickets.length === 1 ? 'ticket' : 'tickets'} · actualizado {relativeTime(jira.fetchedAt)} · se actualiza solo cada {JIRA_AUTO_REFRESH_MIN} min
              </span>
            )}
          </div>
        </div>
        <div className="spacer" />
        {jira.tickets.length >= TICKET_SEARCH_FROM && (
          <label className="search small">
            <Icon name="search" />
            <input placeholder="Filtrar tickets…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filtrar tickets" />
          </label>
        )}
        {jira.connection !== 'none' && (
          <button className="btn" onClick={onRefresh} disabled={loading} title={`Actualizar desde Jira (${MOD}R)`}>
            <span className={loading ? 'spin' : ''}><Icon name="refresh" /></span>
            {loading ? 'Actualizando…' : 'Actualizar desde Jira'}
          </button>
        )}
      </div>

      {empty ? (
        <div className="empty-state">{empty}</div>
      ) : tickets.length === 0 ? (
        <div className="empty-msg">Ningún ticket coincide con “{query}”.</div>
      ) : (
        <div className="tickets">
          {tickets.map((ticket) => {
            const logged = perTicket.get(ticket.key) ?? 0;
            const ready = canOrchestrate(ticket.status);
            return (
              <div key={ticket.key} className={`tk${ready ? ' has-run' : ''}`}>
                <button
                  className="tk-main"
                  title={`Registrar un test para ${ticket.key}`}
                  onClick={() => onTicket(ticket)}
                >
                  <span className="tk-top">
                    <b className="tk-key">{ticket.key}</b>
                    <span className={`chip tone-${ticketTone(ticket.status)}`}>{ticket.status}</span>
                  </span>
                  <span className="tk-sum">{ticket.summary}</span>
                  <span className="tk-foot">
                    {logged > 0 ? (
                      <span className="tk-logged"><Icon name="check" size={13} /> {logged} reg.</span>
                    ) : (
                      <span className="hint">Sin registros</span>
                    )}
                    <span className="tk-cta">Registrar test <Icon name="arrow" size={13} /></span>
                  </span>
                </button>
                {base && (
                  <a
                    className="tk-open"
                    href={base + encodeURIComponent(ticket.key)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Abrir ${ticket.key} en Jira`}
                    aria-label={`Abrir ${ticket.key} en Jira`}
                  >
                    <Icon name="external" size={14} />
                  </a>
                )}
                {ready && (
                  <button
                    className="tk-run"
                    onClick={() => onOrchestrate(ticket)}
                    disabled={launching !== null}
                    title={`Abre Terminal con Claude Code: ${ORCHESTRATOR_SKILL} ${ticket.key}`}
                  >
                    <Icon name="play" size={13} />
                    {launching === ticket.key ? 'Abriendo Terminal…' : 'Ejecutar orquestador QA'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Primeros pasos: solo mientras no hay registros. */
function Onboarding({ jiraConnected, onOpenSettings, onNewRun }: { jiraConnected: boolean; onOpenSettings: () => void; onNewRun: () => void }) {
  return (
    <div className="card onboarding">
      <h3 className="title">Empieza en dos pasos</h3>
      <ol className="steps">
        <li className={jiraConnected ? 'done' : ''}>
          <span className="step-n">{jiraConnected ? <Icon name="check" size={14} /> : 1}</span>
          <div>
            <b>Conecta Jira</b>
            <p className="hint">Tus tickets aparecerán como tarjetas listas para registrar.</p>
          </div>
          {!jiraConnected && <button className="btn" onClick={onOpenSettings}>Conectar</button>}
        </li>
        <li>
          <span className="step-n">2</span>
          <div>
            <b>Registra tu primer test</b>
            <p className="hint">Pulsa un ticket o crea un registro libre (Smoke, Regression…).</p>
          </div>
          <button className="btn primary" onClick={onNewRun}>Nuevo registro</button>
        </li>
      </ol>
    </div>
  );
}

export function Dashboard({ state, jiraLoading, onRefreshJira, onTicket, onOrchestrate, launching, onRegression, onSmoke, onDismissAutomation, onNewRun, onOpenSettings }: DashboardProps) {
  const [period, setPeriod] = useState<Period>(30);
  const { settings, runs, jira } = state;
  // Se memoriza por valor para que las estadísticas solo se recalculen al cambiar de día.
  const todayYmd = toYmd(new Date());
  const today = useMemo(() => parseYmd(todayYmd), [todayYmd]);

  const view = useMemo(() => {
    const inPeriod = filterByPeriod(runs, period, today);
    const todayRuns = runs.filter((r) => r.date === todayYmd);
    return {
      inPeriod,
      summary: summarize(inPeriod),
      today: summarize(todayRuns),
      buckets: buildBuckets(runs, period, today),
      byType: countByType(inPeriod),
      lastByType: lastRunByType(runs),
      perTicket: countByTicket(runs),
      recent: sortRuns(runs).slice(0, 8),
      todayCount: todayRuns.length,
    };
  }, [runs, period, today, todayYmd]);

  const { summary } = view;
  const kpis: Array<[label: string, value: string | number, sub: string, tone?: string]> = [
    ['Ejecuciones', summary.executions, `${view.todayCount} hoy`],
    ['Casos ejecutados', summary.cases, `${summary.failed} failed · ${summary.blocked} blocked`],
    [
      'Pass rate',
      summary.passRate === null ? '—' : `${summary.passRate}%`,
      summary.passRateBasis === 'none'
        ? 'sin datos'
        : `${summary.passNumerator} de ${summary.passDenominator} ${summary.passRateBasis === 'cases' ? 'casos' : 'ejecuciones'}`,
      summary.passRate === null ? undefined : summary.passRate >= 90 ? 'ok' : summary.passRate >= 70 ? 'warn' : 'bad',
    ],
    ['Bugs encontrados', summary.bugs, summary.bugs ? 'en el período' : 'ninguno en el período', summary.bugs ? 'bad' : undefined],
    ['Tiempo', `${(summary.minutes / 60).toFixed(1)} h`, `${summary.minutes} min`],
  ];
  const maxByType = view.byType[0]?.total ?? 1;
  const daily = period === 7 || period === 30;
  const majors = settings.types.filter((t) => t.major);

  return (
    <section className="dashboard">
      <div className="hero">
        <div>
          <h2>{greeting(new Date())}</h2>
          <p className="hint cap">{longDate(new Date())}</p>
        </div>
        <div className="spacer" />
        <div className="today">
          <span><b>{view.todayCount}</b> {view.todayCount === 1 ? 'registro' : 'registros'} hoy</span>
          <span><b>{view.today.cases}</b> casos</span>
          <span className={view.today.bugs ? 'text-bad' : ''}><b>{view.today.bugs}</b> bugs</span>
        </div>
      </div>

      {runs.length === 0 && (
        <Onboarding jiraConnected={jira.connection === 'connected'} onOpenSettings={onOpenSettings} onNewRun={onNewRun} />
      )}

      <JiraTickets
        jira={jira}
        loading={jiraLoading}
        ticketBase={settings.ticketBase}
        perTicket={view.perTicket}
        onRefresh={onRefreshJira}
        onTicket={onTicket}
        onOrchestrate={onOrchestrate}
        launching={launching}
        onOpenSettings={onOpenSettings}
      />

      <div className="row section-head">
        <h2>Resumen</h2>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <button key={p.value} className={p.value === period ? 'on' : ''} aria-pressed={p.value === period} onClick={() => setPeriod(p.value)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        {kpis.map(([label, value, sub, tone]) => (
          <div key={label} className="card kpi">
            <div className="lbl">{label}</div>
            <div className={`val${tone ? ` text-${tone}` : ''}`}>{value}</div>
            <div className="sub">{sub || ' '}</div>
          </div>
        ))}
      </div>

      {majors.length > 0 && (
        <div className="majors">
          {majors.map((type) => {
            const last = view.lastByType.get(type.id);
            return (
              <div key={type.id} className="card major" style={{ borderLeftColor: type.color }}>
                <div className="major-head">
                  <div className="name"><span className="star">★</span> {type.name}</div>
                  {last && <ResultPill result={last.result} />}
                </div>
                {last ? (
                  <div className="meta">
                    <b>{last.title}</b>
                    <br />
                    {formatDmy(last.date)} · {relativeDay(last.date, today)}{last.env ? ` · ${last.env}` : ''}
                  </div>
                ) : (
                  <div className="meta">Aún no hay ejecuciones de {type.name}.</div>
                )}
                <div className="meta">{view.inPeriod.filter((r) => r.typeId === type.id).length} en el período</div>
                {isRegressionType(type.name) && (
                  <button className="btn small major-run" onClick={onRegression} title="Abre Terminal con Claude Code y el skill de regresión">
                    <Icon name="play" size={13} /> Ejecutar regresión
                  </button>
                )}
                {isSmokeType(type.name) && (
                  <div className="major-run btn-row">
                    {(Object.keys(SMOKE_SITES) as SmokeSite[]).map((site) => (
                      <button
                        key={site}
                        className="btn small"
                        onClick={() => onSmoke(site)}
                        disabled={launching !== null}
                        title={`Abre Terminal con Claude Code y el smoke en ${SMOKE_SITES[site].url}`}
                      >
                        <Icon name="play" size={13} />
                        {launching === `smoke:${site}` ? 'Abriendo Terminal…' : `Smoke en ${SMOKE_SITES[site].label}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Automations automations={state.automations} runs={state.runs} onDismiss={onDismissAutomation} />

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
