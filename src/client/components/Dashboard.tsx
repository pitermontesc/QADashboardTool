import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RESULT_META, resultLabel } from '../../shared/defaults';
import { formatDmy, greeting, longDate, parseYmd, relativeDay, relativeTime, toYmd } from '../../shared/dates';
import {
  bugKeysByRun, countedRuns, buildBuckets, countByTicket, countByType, filterByPeriod, lastRunByType, sortRuns, summarize,
  type Bucket, type Period, type ResultCounts,
} from '../../shared/stats';
import { ORCHESTRATOR_FULL_COVERAGE, canOrchestrate, isRegressionType, isSmokeType, siteForStatus } from '../../shared/orchestrator';
import { claimFor, claimText, ownLastValidation } from '../../shared/claims';
import { RESULTS, type AppState, type Automation, type JiraTicket, type QueueItem, type TicketClaim } from '../../shared/types';
import { queuePosition, queuedOf, ticketsToValidate } from '../../shared/queue';
import { QueuePanel } from './Queue';
import { SetupBanner } from './SetupCard';
import { Automations, elapsedMin, runningOf } from './Automations';
import { useLang, useText } from '../i18n';
import { useNow } from '../useNow';
import { Icon } from './icons';
import { findType, JiraStatus, MOD, ResultPill, RunsTable, ticketTone } from './ui';

const PERIODS: readonly Period[] = [7, 30, 90, 0];

const TEXT = {
  es: {
    period: (p: Period) => (p === 0 ? 'Todo' : `${p} días`),
    periodLabel: 'Período',
    executionsAt: (label: string, n: number) => `${label}: ${n} ejecuciones`,
    connectJiraHint: 'Conecta Jira para ver aquí los tickets que tienes que probar y registrarlos con un clic.',
    connectJira: 'Conectar Jira',
    jiraFailed: 'No se pudo conectar con Jira:',
    retry: 'Reintentar',
    checkConnection: 'Revisar conexión',
    allClear: 'Todo al día: no hay tickets pendientes de probar con tu filtro. 🎉',
    configured: 'La conexión está configurada. Carga los tickets para empezar.',
    loadTickets: 'Cargar tickets',
    ticketsTitle: 'Tickets por probar',
    ticketsMeta: (n: number, ago: string, every: number) =>
      `${n} ${n === 1 ? 'ticket' : 'tickets'} · actualizado ${ago} · se actualiza solo cada ${every} min`,
    filterTickets: 'Filtrar tickets…',
    filterTicketsLabel: 'Filtrar tickets',
    refreshJira: 'Actualizar desde Jira',
    refreshing: 'Actualizando…',
    noMatch: (q: string) => `Ningún ticket coincide con “${q}”.`,
    logTestFor: (key: string) => `Registrar un test para ${key}`,
    logged: (n: number) => `${n} reg.`,
    noRuns: 'Sin registros',
    logTest: 'Registrar test',
    openInJira: (key: string) => `Abrir ${key} en Jira`,
    orchestratorTitle: (cmd: string) => `Corre Claude Code en segundo plano: ${cmd}`,
    openingTerminal: 'Iniciando…',
    running: 'En curso',
    runningFor: (what: string, min: number) => `En curso · ${what} · ${min} min`,
    validating: 'validando',
    seeProgress: 'Ver el progreso de la ejecución',
    runOrchestrator: 'Ejecutar orquestador QA',
    fullCoverage: 'Completa',
    fullCoverageLabel: (key: string) => `Ejecutar el orquestador QA en ${key} con cobertura completa`,
    fullCoverageTitle: (cmd: string) =>
      `Cobertura completa: corre todos los agentes del orquestador (análisis, impacto, estrategia, ejecución, regresión, TCs de automatización y bugs) aunque el ticket sea chico. Tarda más y usa más tokens. Corre: ${cmd}`,
    startTitle: 'Empieza en dos pasos',
    stepJira: 'Conecta Jira',
    stepJiraHint: 'Tus tickets aparecerán como tarjetas listas para registrar.',
    connect: 'Conectar',
    stepRun: 'Registra tu primer test',
    stepRunHint: 'Pulsa un ticket o crea un registro libre (Smoke, Regression…).',
    newRun: 'Nuevo registro',
    kpiExecutions: 'Ejecuciones',
    today: (n: number) => `${n} hoy`,
    kpiCases: 'Casos ejecutados',
    noData: 'sin datos',
    passBasis: (num: number, den: number, cases: boolean) => `${num} de ${den} ${cases ? 'casos' : 'ejecuciones'}`,
    kpiBugs: 'Bugs encontrados',
    inPeriod: 'en el período',
    noneInPeriod: 'ninguno en el período',
    kpiTime: 'Tiempo',
    rehearsals: (n: number) =>
      n === 1
        ? 'Una ejecución en modo prueba no cuenta en estos números: sigue en Registros con su reporte.'
        : `${n} ejecuciones en modo prueba no cuentan en estos números: siguen en Registros con sus reportes.`,
    todayRuns: (n: number): string => (n === 1 ? 'registro hoy' : 'registros hoy'),
    cases: 'casos',
    summary: 'Resumen',
    noRunsOf: (name: string) => `Aún no hay ejecuciones de ${name}.`,
    countInPeriod: (n: number) => `${n} en el período`,
    regressionTitle: 'Corre Claude Code en segundo plano con el skill de regresión',
    runRegression: 'Ejecutar regresión',
    smokeTitle: (url: string) => `Corre Claude Code en segundo plano con el smoke en ${url}`,
    smokeOn: (site: string) => `Smoke en ${site}`,
    queuedAt: (n: number) => `En cola · #${n}`,
    queuedTitle: 'Espera en la cola de su sitio: empieza cuando el sitio se libere',
    runAnyway: '¿Lanzar igual?',
    claimTitle: 'Según la carpeta del equipo (se lee cada minuto)',
    validateAll: (n: number) => `Validar todos (${n})`,
    validateAllTitle: 'Encola los tickets listos y los corre uno a la vez por sitio',
    activity: (daily: boolean, weeks: number) => `Actividad ${daily ? 'por día' : `por semana (últimas ${weeks})`}`,
    byType: 'Por tipo de test',
    noneInPeriodRuns: 'Sin ejecuciones en el período.',
    latest: 'Últimos registros',
  },
  en: {
    period: (p: Period) => (p === 0 ? 'All' : `${p} days`),
    periodLabel: 'Period',
    executionsAt: (label: string, n: number) => `${label}: ${n} runs`,
    connectJiraHint: 'Connect Jira to see the tickets you need to test here and log them in one click.',
    connectJira: 'Connect Jira',
    jiraFailed: 'Could not connect to Jira:',
    retry: 'Retry',
    checkConnection: 'Check connection',
    allClear: 'All caught up: no tickets waiting to be tested with your filter. 🎉',
    configured: 'The connection is set up. Load the tickets to get started.',
    loadTickets: 'Load tickets',
    ticketsTitle: 'Tickets to test',
    ticketsMeta: (n: number, ago: string, every: number) =>
      `${n} ${n === 1 ? 'ticket' : 'tickets'} · updated ${ago} · refreshes every ${every} min`,
    filterTickets: 'Filter tickets…',
    filterTicketsLabel: 'Filter tickets',
    refreshJira: 'Refresh from Jira',
    refreshing: 'Refreshing…',
    noMatch: (q: string) => `No ticket matches “${q}”.`,
    logTestFor: (key: string) => `Log a test for ${key}`,
    logged: (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`,
    noRuns: 'No runs',
    logTest: 'Log test',
    openInJira: (key: string) => `Open ${key} in Jira`,
    orchestratorTitle: (cmd: string) => `Runs Claude Code in the background: ${cmd}`,
    openingTerminal: 'Starting…',
    running: 'Running',
    runningFor: (what: string, min: number) => `Running · ${what} · ${min} min`,
    validating: 'validating',
    seeProgress: 'See the run progress',
    runOrchestrator: 'Run QA orchestrator',
    fullCoverage: 'Full',
    fullCoverageLabel: (key: string) => `Run the QA orchestrator on ${key} with full coverage`,
    fullCoverageTitle: (cmd: string) =>
      `Full coverage: runs every orchestrator agent (analysis, impact, strategy, execution, regression, automation TCs and bugs) even on a small ticket. It takes longer and uses more tokens. Runs: ${cmd}`,
    startTitle: 'Get started in two steps',
    stepJira: 'Connect Jira',
    stepJiraHint: 'Your tickets will show up as cards ready to log.',
    connect: 'Connect',
    stepRun: 'Log your first test',
    stepRunHint: 'Click a ticket or create a free-form run (Smoke, Regression…).',
    newRun: 'New run',
    kpiExecutions: 'Runs',
    today: (n: number) => `${n} today`,
    kpiCases: 'Cases executed',
    noData: 'no data',
    passBasis: (num: number, den: number, cases: boolean) => `${num} of ${den} ${cases ? 'cases' : 'runs'}`,
    kpiBugs: 'Bugs found',
    inPeriod: 'in the period',
    noneInPeriod: 'none in the period',
    kpiTime: 'Time',
    rehearsals: (n: number) =>
      n === 1
        ? 'One run in test mode does not count in these numbers: it stays in Runs with its report.'
        : `${n} runs in test mode do not count in these numbers: they stay in Runs with their reports.`,
    todayRuns: (n: number): string => (n === 1 ? 'run today' : 'runs today'),
    cases: 'cases',
    summary: 'Summary',
    noRunsOf: (name: string) => `No ${name} runs yet.`,
    countInPeriod: (n: number) => `${n} in the period`,
    regressionTitle: 'Runs Claude Code in the background with the regression skill',
    runRegression: 'Run regression',
    smokeTitle: (url: string) => `Runs Claude Code in the background with the smoke on ${url}`,
    smokeOn: (site: string) => `Smoke on ${site}`,
    queuedAt: (n: number) => `Queued · #${n}`,
    queuedTitle: 'Waiting in its site queue: it starts when the site is free',
    runAnyway: 'Run anyway?',
    claimTitle: 'From the team folder (read every minute)',
    validateAll: (n: number) => `Validate all (${n})`,
    validateAllTitle: 'Queues the ready tickets and runs them one at a time per site',
    activity: (daily: boolean, weeks: number) => `Activity ${daily ? 'per day' : `per week (last ${weeks})`}`,
    byType: 'By test type',
    noneInPeriodRuns: 'No runs in the period.',
    latest: 'Latest runs',
  },
};
type Text = typeof TEXT.es;

/** Ticket count from which the section's search box appears. */
const TICKET_SEARCH_FROM = 7;
/** How many minutes between automatic Jira ticket refreshes. */
export const JIRA_AUTO_REFRESH_MIN = 5;

interface DashboardProps {
  state: AppState;
  jiraLoading: boolean;
  onRefreshJira: () => void;
  onTicket: (ticket: JiraTicket) => void;
  onOrchestrate: (ticket: JiraTicket, fullCoverage?: boolean) => void;
  /** Ticket whose orchestrator is being launched. */
  launching: string | null;
  onRegression: () => void;
  /** Opens "Validate all" (queue every ready ticket). */
  onValidateAll: () => void;
  onQueueMove: (item: QueueItem, direction: 'up' | 'down') => void;
  onQueueRemove: (item: QueueItem) => void;
  onQueueResume: (site: string) => void;
  /** Launches the smoke on one of the configured sites (by its id). */
  onSmoke: (siteId: string) => void;
  onDismissAutomation: (automation: Automation) => void;
  onOpenReport: (automation: Automation) => void;
  onNewRun: () => void;
  onOpenSettings: () => void;
}

/** Segments stacked by result; used in both charts. */
function Segments({ counts }: { counts: ResultCounts }) {
  const lang = useLang();
  return (
    <>
      {RESULTS.filter((r) => counts[r] > 0).map((r) => (
        <i key={r} style={{ flex: counts[r], background: RESULT_META[r].color }} title={`${resultLabel(r, lang)}: ${counts[r]}`} />
      ))}
    </>
  );
}

function ActivityChart({ buckets, t }: { buckets: Bucket[]; t: Text }) {
  const lang = useLang();
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const labelEvery = Math.ceil(buckets.length / 10);
  return (
    <>
      <div className="chart">
        {buckets.map((b) => (
          <div key={b.from} className={b.total ? 'col' : 'col empty'} title={t.executionsAt(b.label, b.total)}>
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
            {resultLabel(r, lang)}
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
  onOrchestrate: (ticket: JiraTicket, fullCoverage?: boolean) => void;
  launching: string | null;
  onOpenSettings: () => void;
  automations: Automation[];
  onOpenReport: (automation: Automation) => void;
  qa: AppState['settings']['qa'];
  queue: QueueItem[];
  /** What teammates are doing on tickets (team folder). */
  claims: TicketClaim[];
  /** Tickets "Validate all" would offer (0 hides the button). */
  validateCount: number;
  onValidateAll: () => void;
  t: Text;
}

/** Jira tickets as cards: the usual starting point for logging a test. */
function JiraTickets({
  jira, loading, ticketBase, perTicket, onRefresh, onTicket, onOrchestrate, launching, onOpenSettings, automations, onOpenReport, qa, queue, claims, validateCount, onValidateAll, t,
}: TicketsProps) {
  const lang = useLang();
  const now = useNow();
  const [query, setQuery] = useState('');
  // A ticket a teammate is validating or has queued needs a second click ("key" or "full:key").
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
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
          <p>{t.connectJiraHint}</p>
          <button className="btn primary" onClick={onOpenSettings}>{t.connectJira}</button>
        </>
      ) : jira.connection === 'error' ? (
        <>
          <p className="text-bad">{t.jiraFailed} {jira.error}</p>
          <div className="btn-row">
            <button className="btn" onClick={onRefresh} disabled={loading}>{t.retry}</button>
            <button className="btn" onClick={onOpenSettings}>{t.checkConnection}</button>
          </div>
        </>
      ) : jira.connection === 'connected' ? (
        <p>{t.allClear}</p>
      ) : (
        <>
          <p>{t.configured}</p>
          <button className="btn primary" onClick={onRefresh} disabled={loading}>{t.loadTickets}</button>
        </>
      );
  }

  return (
    <div className="card section-tickets">
      <div className="card-head">
        <div>
          <h3 className="title">{t.ticketsTitle}</h3>
          <div className="card-sub">
            <JiraStatus jira={jira} loading={loading} />
            {jira.connection === 'connected' && jira.fetchedAt !== null && (
              <span className="hint">
                {t.ticketsMeta(jira.tickets.length, relativeTime(jira.fetchedAt, now, lang), JIRA_AUTO_REFRESH_MIN)}
              </span>
            )}
          </div>
        </div>
        <div className="spacer" />
        {jira.tickets.length >= TICKET_SEARCH_FROM && (
          <label className="search small">
            <Icon name="search" />
            <input placeholder={t.filterTickets} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t.filterTicketsLabel} />
          </label>
        )}
        {validateCount > 0 && (
          <button className="btn" onClick={onValidateAll} title={t.validateAllTitle}>
            <Icon name="play" /> {t.validateAll(validateCount)}
          </button>
        )}
        {jira.connection !== 'none' && (
          <button className="btn" onClick={onRefresh} disabled={loading} title={`${t.refreshJira} (${MOD}R)`}>
            <span className={loading ? 'spin' : ''}><Icon name="refresh" /></span>
            {loading ? t.refreshing : t.refreshJira}
          </button>
        )}
      </div>

      {empty ? (
        <div className="empty-state">{empty}</div>
      ) : tickets.length === 0 ? (
        <div className="empty-msg">{t.noMatch(query)}</div>
      ) : (
        <div className="tickets">
          {tickets.map((ticket) => {
            const logged = perTicket.get(ticket.key) ?? 0;
            const ready = canOrchestrate(ticket.status, qa);
            const active = runningOf(automations, 'orchestrator', ticket.key);
            const waiting = queuedOf(queue, 'orchestrator', ticket.key);
            const claim = ready && !active && !waiting ? claimFor(claims, ticket.key, siteForStatus(ticket.status, qa) ?? null, ownLastValidation(automations, ticket.key)) : null;
            const launch = (full: boolean): void => {
              const id = `${full ? 'full:' : ''}${ticket.key}`;
              if (claim && claim.state !== 'validated' && armed !== id) return setArmed(id);
              setArmed(null);
              onOrchestrate(ticket, full || undefined);
            };
            return (
              <div key={ticket.key} className={`tk${ready || active ? ' has-run' : ''}${active ? ' is-running' : ''}`}>
                <button
                  className="tk-main"
                  title={t.logTestFor(ticket.key)}
                  onClick={() => onTicket(ticket)}
                >
                  <span className="tk-top">
                    <b className="tk-key">{ticket.key}</b>
                    <span className={`chip tone-${ticketTone(ticket.status)}`}>{ticket.status}</span>
                  </span>
                  <span className="tk-sum">{ticket.summary}</span>
                  <span className="tk-foot">
                    {logged > 0 ? (
                      <span className="tk-logged"><Icon name="check" size={13} /> {t.logged(logged)}</span>
                    ) : (
                      <span className="hint">{t.noRuns}</span>
                    )}
                    <span className="tk-cta">{t.logTest} <Icon name="arrow" size={13} /></span>
                  </span>
                </button>
                {base && (
                  <a
                    className="tk-open"
                    href={base + encodeURIComponent(ticket.key)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t.openInJira(ticket.key)}
                    aria-label={t.openInJira(ticket.key)}
                  >
                    <Icon name="external" size={14} />
                  </a>
                )}
                {active ? (
                  <button className="tk-run running" onClick={() => onOpenReport(active)} title={t.seeProgress}>
                    <i className="run-dot" />
                    {t.runningFor(t.validating, elapsedMin(active, now))}
                  </button>
                ) : waiting ? (
                  <span className="tk-run queued" title={t.queuedTitle}>
                    <Icon name="clock" size={13} />
                    {t.queuedAt(queuePosition(queue, waiting))}
                  </span>
                ) : ready && (
                  <>
                  {claim && (
                    <span className={`tk-claim claim-${claim.state}`} title={t.claimTitle}>
                      <Icon name="team" size={13} />
                      <span className="tk-run-label">{claimText(claim, lang, now)}</span>
                    </span>
                  )}
                  <div className="tk-runs">
                    <button
                      className={`tk-run${armed === ticket.key ? ' armed' : ''}`}
                      onClick={() => launch(false)}
                      disabled={launching !== null}
                      title={t.orchestratorTitle(`${qa.skills.orchestrator} ${ticket.key}`)}
                    >
                      <Icon name="play" size={13} />
                      <span className="tk-run-label">{launching === ticket.key ? t.openingTerminal : armed === ticket.key ? t.runAnyway : t.runOrchestrator}</span>
                    </button>
                    <button
                      className={`tk-run tk-full${armed === `full:${ticket.key}` ? ' armed' : ''}`}
                      onClick={() => launch(true)}
                      disabled={launching !== null}
                      aria-label={t.fullCoverageLabel(ticket.key)}
                      title={t.fullCoverageTitle(`${qa.skills.orchestrator} ${ticket.key}${ORCHESTRATOR_FULL_COVERAGE}`)}
                    >
                      {launching === `full:${ticket.key}` ? t.openingTerminal : armed === `full:${ticket.key}` ? t.runAnyway : t.fullCoverage}
                    </button>
                  </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Getting started: shown only while there are no runs. */
function Onboarding({ jiraConnected, onOpenSettings, onNewRun, t }: { jiraConnected: boolean; onOpenSettings: () => void; onNewRun: () => void; t: Text }) {
  return (
    <div className="card onboarding">
      <h3 className="title">{t.startTitle}</h3>
      <ol className="steps">
        <li className={jiraConnected ? 'done' : ''}>
          <span className="step-n">{jiraConnected ? <Icon name="check" size={14} /> : 1}</span>
          <div>
            <b>{t.stepJira}</b>
            <p className="hint">{t.stepJiraHint}</p>
          </div>
          {!jiraConnected && <button className="btn" onClick={onOpenSettings}>{t.connect}</button>}
        </li>
        <li>
          <span className="step-n">2</span>
          <div>
            <b>{t.stepRun}</b>
            <p className="hint">{t.stepRunHint}</p>
          </div>
          <button className="btn primary" onClick={onNewRun}>{t.newRun}</button>
        </li>
      </ol>
    </div>
  );
}

export function Dashboard({
  state, jiraLoading, onRefreshJira, onTicket, onOrchestrate, launching, onRegression, onValidateAll, onQueueMove, onQueueRemove, onQueueResume, onSmoke,
  onDismissAutomation, onOpenReport, onNewRun, onOpenSettings,
}: DashboardProps) {
  const [period, setPeriod] = useState<Period>(30);
  const lang = useLang();
  const t = useText(TEXT);
  const now = useNow();
  const { settings, runs, jira, automations } = state;
  // Memoized by value so stats are only recomputed when the day changes.
  const todayYmd = toYmd(new Date(now));
  const today = useMemo(() => parseYmd(todayYmd), [todayYmd]);

  // The same Jira bug found by several runs (for example, on QA and on STG) counts once.
  const bugKeys = useMemo(() => bugKeysByRun(automations), [automations]);
  const view = useMemo(() => {
    // Runs in test mode are rehearsals: listed in Recent runs and Runs, but not in the numbers or charts.
    const counted = countedRuns(runs);
    const inPeriod = filterByPeriod(counted, period, today);
    const todayRuns = counted.filter((r) => r.date === todayYmd);
    return {
      inPeriod,
      rehearsals: filterByPeriod(runs, period, today).length - inPeriod.length,
      summary: summarize(inPeriod, bugKeys),
      today: summarize(todayRuns, bugKeys),
      buckets: buildBuckets(counted, period, today, lang),
      byType: countByType(inPeriod),
      lastByType: lastRunByType(counted),
      perTicket: countByTicket(runs),
      recent: sortRuns(runs).slice(0, 8),
      todayCount: todayRuns.length,
    };
  }, [runs, period, today, todayYmd, lang, bugKeys]);

  const { summary } = view;
  const kpis: Array<[label: string, value: string | number, sub: string, tone?: string]> = [
    [t.kpiExecutions, summary.executions, t.today(view.todayCount)],
    [t.kpiCases, summary.cases, `${summary.failed} failed · ${summary.blocked} blocked`],
    [
      'Pass rate',
      summary.passRate === null ? '—' : `${summary.passRate}%`,
      summary.passRateBasis === 'none'
        ? t.noData
        : t.passBasis(summary.passNumerator, summary.passDenominator, summary.passRateBasis === 'cases'),
      summary.passRate === null ? undefined : summary.passRate >= 90 ? 'ok' : summary.passRate >= 70 ? 'warn' : 'bad',
    ],
    [t.kpiBugs, summary.bugs, summary.bugs ? t.inPeriod : t.noneInPeriod, summary.bugs ? 'bad' : undefined],
    [t.kpiTime, `${(summary.minutes / 60).toFixed(1)} h`, `${summary.minutes} min`],
  ];
  const maxByType = view.byType[0]?.total ?? 1;
  const daily = period === 7 || period === 30;
  const majors = settings.types.filter((t) => t.major);

  return (
    <section className="dashboard">
      <div className="hero">
        <div>
          <h2>{greeting(new Date(now), lang)}</h2>
          <p className="hint cap">{longDate(new Date(now), lang)}</p>
        </div>
        <div className="spacer" />
        <div className="today">
          <span><b>{view.todayCount}</b> {t.todayRuns(view.todayCount)}</span>
          <span><b>{view.today.cases}</b> {t.cases}</span>
          <span className={view.today.bugs ? 'text-bad' : ''}><b>{view.today.bugs}</b> bugs</span>
        </div>
      </div>

      <SetupBanner setup={state.setup} onOpenSettings={onOpenSettings} />

      {runs.length === 0 && (
        <Onboarding jiraConnected={jira.connection === 'connected'} onOpenSettings={onOpenSettings} onNewRun={onNewRun} t={t} />
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
        automations={state.automations}
        onOpenReport={onOpenReport}
        qa={settings.qa}
        queue={state.queue.items}
        claims={state.team.claims}
        validateCount={ticketsToValidate(state).length}
        onValidateAll={onValidateAll}
        t={t}
      />

      <QueuePanel state={state} onMove={onQueueMove} onRemove={onQueueRemove} onResume={onQueueResume} />

      <div className="row section-head">
        <h2>{t.summary}</h2>
        <div className="spacer" />
        <div className="seg" role="group" aria-label={t.periodLabel}>
          {PERIODS.map((p) => (
            <button key={p} className={p === period ? 'on' : ''} aria-pressed={p === period} onClick={() => setPeriod(p)}>
              {t.period(p)}
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
      {view.rehearsals > 0 && <p className="hint rehearsals">{t.rehearsals(view.rehearsals)}</p>}

      {majors.length > 0 && (
        <div className="majors">
          {majors.map((type) => {
            const last = view.lastByType.get(type.id);
            const kind = isSmokeType(type.name) ? 'smoke' : isRegressionType(type.name) ? 'regression' : null;
            const busy = kind ? runningOf(state.automations, kind) : undefined;
            return (
              <div key={type.id} className="card major" style={{ borderLeftColor: type.color }}>
                <div className="major-head">
                  <div className="name"><span className="star">★</span> {type.name}</div>
                  {busy ? (
                    <button className="status-pill tone-prog pulsing pill-btn" onClick={() => onOpenReport(busy)} title={t.seeProgress}>
                      <i />{t.running}
                    </button>
                  ) : last && <ResultPill result={last.result} />}
                </div>
                {last ? (
                  <div className="meta">
                    <b>{last.title}</b>
                    <br />
                    {formatDmy(last.date, lang)} · {relativeDay(last.date, today, lang)}{last.env ? ` · ${last.env}` : ''}
                  </div>
                ) : (
                  <div className="meta">{t.noRunsOf(type.name)}</div>
                )}
                <div className="meta">{t.countInPeriod(view.inPeriod.filter((r) => r.typeId === type.id).length)}</div>
                {isRegressionType(type.name) && (() => {
                  const active = runningOf(state.automations, 'regression');
                  const waiting = queuedOf(state.queue.items, 'regression');
                  return active ? (
                    <button className="btn small major-run running" onClick={() => onOpenReport(active)} title={t.seeProgress}>
                      <i className="run-dot" /> {t.runningFor(active.target || 'testomat.io', elapsedMin(active, now))}
                    </button>
                  ) : waiting ? (
                    <span className="btn small major-run queued" title={t.queuedTitle}>
                      <Icon name="clock" size={13} /> {t.queuedAt(queuePosition(state.queue.items, waiting))}
                    </span>
                  ) : (
                    <button className="btn small major-run" onClick={onRegression} title={t.regressionTitle}>
                      <Icon name="play" size={13} /> {t.runRegression}
                    </button>
                  );
                })()}
                {isSmokeType(type.name) && (
                  <div className="major-run btn-row">
                    {settings.qa.sites.map((site) => {
                      const active = runningOf(state.automations, 'smoke', site.name);
                      const waiting = queuedOf(state.queue.items, 'smoke', site.name);
                      return active ? (
                        <button key={site.id} className="btn small running" onClick={() => onOpenReport(active)} title={t.seeProgress}>
                          <i className="run-dot" /> {t.runningFor(site.name, elapsedMin(active, now))}
                        </button>
                      ) : waiting ? (
                        <span key={site.id} className="btn small queued" title={t.queuedTitle}>
                          <Icon name="clock" size={13} /> {`${site.name} · ${t.queuedAt(queuePosition(state.queue.items, waiting))}`}
                        </span>
                      ) : (
                      <button
                        key={site.id}
                        className="btn small"
                        onClick={() => onSmoke(site.id)}
                        disabled={launching !== null}
                        title={t.smokeTitle(site.url)}
                      >
                        <Icon name="play" size={13} />
                        {launching === `smoke:${site.id}` ? t.openingTerminal : t.smokeOn(site.name)}
                      </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Automations automations={state.automations} runs={state.runs} onDismiss={onDismissAutomation} onOpen={onOpenReport} />

      <div className="grid2 even">
        <div className="card">
          <h3>{t.activity(daily, view.buckets.length)}</h3>
          <ActivityChart buckets={view.buckets} t={t} />
        </div>
        <div className="card">
          <h3>{t.byType}</h3>
          {view.byType.length === 0 ? (
            <div className="empty-msg">{t.noneInPeriodRuns}</div>
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
        <h3>{t.latest}</h3>
        <div className="tablewrap">
          <RunsTable runs={view.recent} settings={settings} />
        </div>
      </div>
    </section>
  );
}
