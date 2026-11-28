import { claimFor, ownLastValidation } from './claims.js';
import { findSite, siteForStatus } from './orchestrator.js';
import type { AppState, Automation, JiraTicket, Lang, QaConfig, QaSite, QueueItem, TeamState, TicketClaim } from './types.js';

/**
 * Runs that use the browser on a site go one at a time on that site (its "lane"): two runs on the
 * same site share Chrome, the test users and the data, and collide. QA and STG are separate lanes.
 */

/** Lane of a run. Runs from before v1.15.0 have no site saved: it is worked out as best it can be. */
export function laneOf(a: Pick<Automation, 'site' | 'kind' | 'target' | 'env'>, qa: QaConfig): string {
  if (a.site) return a.site;
  if (a.kind === 'smoke') return qa.sites.find((s) => s.name === a.target)?.id ?? '';
  if (a.kind === 'regression') return qa.regressionSiteId;
  return qa.sites.find((s) => s.env === a.env)?.id ?? '';
}

/**
 * Jira priority as a rank: 0 is the most urgent. Named schemes (Highest…Lowest, Blocker…) and numbered
 * ones ("1"…"5" or "P1"…"P5", 1 the most urgent, as in the AVM project) are read; unknown names count as Medium.
 */
export function priorityRank(priority: string): number {
  const p = priority.trim().toLowerCase();
  const numbered = /^p?([1-9])$/.exec(p);
  if (numbered) return Math.min(4, Number(numbered[1]) - 1);
  if (/highest|blocker|critical|urgent/.test(p)) return 0;
  if (/lowest|trivial/.test(p)) return 4;
  if (/high/.test(p)) return 1;
  if (/low/.test(p)) return 3;
  return 2;
}

const DAY_MS = 24 * 60 * 60_000;
/** A ticket moves up one priority level for every this many days since it was created. */
export const AGE_STEP_DAYS = 30;

/** Priority rank after the age bonus, so a low-priority ticket does not wait forever. */
export function effectiveRank(ticket: JiraTicket, now = Date.now()): number {
  const base = priorityRank(ticket.priority);
  if (ticket.created === null) return base;
  return Math.max(0, base - Math.floor((now - ticket.created) / DAY_MS / AGE_STEP_DAYS));
}

/** Staging first: it is the release gate, so a ticket waiting there blocks a deploy. */
export const isReleaseGate = (site: QaSite): boolean => /stg|stag/i.test(`${site.id} ${site.name} ${site.env}`);

/** Lanes in display order: release gate (STG) first, then the order in the settings. */
export function orderedSites(qa: QaConfig): QaSite[] {
  return [...qa.sites].sort((a, b) => Number(isReleaseGate(b)) - Number(isReleaseGate(a)));
}

// ── What a finished run says about the environment ────────────────────────────────────────────────

/** Stopped by the user or by the time limit: says nothing about the site. */
const STOPPED = /Stopped from QA Dashboard|Detenida desde QA Dashboard|time limit|tiempo m[aá]ximo/i;
/** Claude ended without reporting (crashed, closed, killed): not the ticket's fault. */
const UNREPORTED = /without reporting|sin reportar/i;
/** The site, the login or the browser failed, not the ticket. */
const ENVIRONMENT =
  /environment|ambiente|entorno|log ?in|sign[- ]?in|iniciar sesi|sesi[oó]n|site (is )?down|unreachable|not reachable|no respond|no responde|timed? ?out|\b50[234]\b|chrome|extensi[oó]n|extension|not connected|no estaba conectad|could not (reach|load|connect|open)|no se pudo (cargar|conectar|abrir)/i;
/** Claude's plan ran out of usage: every queued run would fail the same way. */
const USAGE_LIMIT = /usage limit|rate limit|limit reached|5-hour limit|weekly limit|l[ií]mite de uso|quota exceeded|credit balance is too low/i;

/** BLOCKED because of the site, the login, the browser or Claude itself (not because of the ticket). */
export function isEnvironmentBlock(a: Pick<Automation, 'verdict' | 'summary'>): boolean {
  if (a.verdict !== 'BLOCKED' || STOPPED.test(a.summary)) return false;
  return UNREPORTED.test(a.summary) || ENVIRONMENT.test(a.summary) || USAGE_LIMIT.test(a.summary);
}

export const isUsageLimit = (a: Pick<Automation, 'verdict' | 'summary'>): boolean => a.verdict === 'BLOCKED' && USAGE_LIMIT.test(a.summary);

// ── How long a run takes ──────────────────────────────────────────────────────────────────────────

/** Used until there is history: minutes. */
const DEFAULT_MINUTES: Record<Automation['kind'], number> = { orchestrator: 30, smoke: 20, regression: 90 };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

export interface Estimate {
  minutes: number;
  /** What it is based on: runs of the same ticket type or site, any run of that kind, or the default. */
  basis: 'similar' | 'kind' | 'default';
}

/**
 * Expected minutes for a run, from earlier runs that did test something (BLOCKED ones end early):
 * the median of the same kind and ticket type (orchestrator) or site (smoke, regression) if there are
 * at least two, else of every run of that kind, else a default.
 */
export function estimateMinutes(
  run: { kind: Automation['kind']; ticketType?: string; site?: string },
  automations: Automation[],
  qa: QaConfig,
  typeOf: (key: string) => string = () => '',
): Estimate {
  const done = automations.filter((a) => a.kind === run.kind && a.finishedAt !== null && a.verdict !== 'BLOCKED');
  const minutes = (list: Automation[]) => list.map((a) => Math.max(1, Math.round((a.finishedAt! - a.startedAt) / 60_000)));
  const similar = done.filter((a) =>
    run.kind === 'orchestrator' ? !!run.ticketType && (a.ticketType || typeOf(a.target)) === run.ticketType : !!run.site && laneOf(a, qa) === run.site,
  );
  if (similar.length >= 2) return { minutes: median(minutes(similar)), basis: 'similar' };
  if (done.length >= 1) return { minutes: median(minutes(done)), basis: 'kind' };
  return { minutes: DEFAULT_MINUTES[run.kind], basis: 'default' };
}

// ── Which tickets, in which order ─────────────────────────────────────────────────────────────────

export interface TicketCandidate {
  ticket: JiraTicket;
  site: QaSite;
  /** Last finished orchestrator run on the ticket, if any. */
  last: Automation | null;
  /** A teammate validating it now, with it queued, or who validated it on this site after this app's last run. */
  claim: TicketClaim | null;
  /** Selected by default: never validated, or its last run was BLOCKED (nothing was really tested), and no teammate claim. */
  suggested: boolean;
  estimate: Estimate;
  /** Priority rank after the age bonus. */
  rank: number;
  /** Its last run was BLOCKED by the environment: it goes last in its site. */
  envBlocked: boolean;
  /** Tickets in the same list it waits for ("is blocked by" in Jira). */
  waitsFor: string[];
}

/**
 * Order within one site:
 * 1. tickets last BLOCKED by the environment go at the end (the site may still be failing);
 * 2. the most urgent Jira priority first, moved up one level every AGE_STEP_DAYS since creation;
 * 3. the shortest estimated run first (more tickets validated sooner);
 * 4. the oldest first, then the key.
 * Then tickets of the same epic are put together (where the first of them is), and a ticket that
 * "is blocked by" another one in the list goes after it.
 */
export function orderLane(candidates: TicketCandidate[]): TicketCandidate[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      Number(a.envBlocked) - Number(b.envBlocked) ||
      a.rank - b.rank ||
      a.estimate.minutes - b.estimate.minutes ||
      (a.ticket.created ?? Number.MAX_SAFE_INTEGER) - (b.ticket.created ?? Number.MAX_SAFE_INTEGER) ||
      a.ticket.key.localeCompare(b.ticket.key, 'en', { numeric: true }),
  );
  // Same epic together, at the place of its first ticket (not across the "BLOCKED last" line).
  const grouped: TicketCandidate[] = [];
  for (const c of sorted) {
    if (grouped.includes(c)) continue;
    grouped.push(c);
    if (c.ticket.epic) grouped.push(...sorted.filter((o) => o !== c && !grouped.includes(o) && o.ticket.epic === c.ticket.epic && o.envBlocked === c.envBlocked));
  }
  // A ticket goes after the ones it is blocked by (bounded, in case Jira has a cycle).
  for (let pass = 0; pass < grouped.length; pass++) {
    let moved = false;
    for (let i = 0; i < grouped.length; i++) {
      const c = grouped[i]!;
      const after = Math.max(-1, ...c.waitsFor.map((key) => grouped.findIndex((o) => o.ticket.key === key)));
      if (after > i) {
        grouped.splice(i, 1);
        grouped.splice(after, 0, c);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return grouped;
}

/**
 * Tickets that "Validate all" offers: in a status ready for the orchestrator, not running and not
 * queued already. Grouped by lane (STG first) and ordered within each lane by `orderLane`.
 */
export function ticketsToValidate(
  state: Pick<AppState, 'jira' | 'automations' | 'queue' | 'settings'> & { team?: Pick<TeamState, 'claims'> },
  now = Date.now(),
): TicketCandidate[] {
  const { qa } = state.settings;
  const busy = new Set([
    ...state.automations.filter((a) => a.kind === 'orchestrator' && a.finishedAt === null).map((a) => a.target),
    ...state.queue.items.filter((q) => q.kind === 'orchestrator').map((q) => q.target),
  ]);
  const typeOf = (key: string): string => state.jira.tickets.find((t) => t.key === key)?.type ?? '';
  const candidates: TicketCandidate[] = [];
  for (const ticket of state.jira.tickets) {
    const site = siteForStatus(ticket.status, qa);
    if (!site || busy.has(ticket.key)) continue;
    const last = state.automations
      .filter((a) => a.kind === 'orchestrator' && a.target === ticket.key && a.finishedAt !== null)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] ?? null;
    // A BLOCKED run of this app tested nothing: a teammate's earlier validation still stands.
    const claim = claimFor(state.team?.claims ?? [], ticket.key, site, ownLastValidation(state.automations, ticket.key));
    candidates.push({
      ticket,
      site,
      last,
      claim,
      suggested: (!last || last.verdict === 'BLOCKED') && !claim,
      estimate: estimateMinutes({ kind: 'orchestrator', ticketType: ticket.type }, state.automations, qa, typeOf),
      rank: effectiveRank(ticket, now),
      envBlocked: last !== null && isEnvironmentBlock(last),
      waitsFor: [],
    });
  }
  for (const c of candidates) c.waitsFor = c.ticket.blockedBy.filter((key) => candidates.some((o) => o.ticket.key === key && o.site.id === c.site.id));
  return orderedSites(qa).flatMap((site) => orderLane(candidates.filter((c) => c.site.id === site.id)));
}

/** "~25 min", "~1 h 10 min". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  return m < 60 ? `~${m} min` : `~${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** Why a ticket is where it is: "Priority High (moved up: 20 d old) · ~25 min · after AVM-1 · epic AVM-500". */
export function candidateReason(c: TicketCandidate, lang: Lang, now = Date.now()): string {
  const en = lang === 'en';
  const parts: string[] = [];
  const { ticket } = c;
  const days = ticket.created === null ? null : Math.max(0, Math.floor((now - ticket.created) / DAY_MS));
  const age = days === null ? '' : en ? (days === 0 ? 'created today' : `created ${days} d ago`) : days === 0 ? 'creado hoy' : `creado hace ${days} d`;
  if (ticket.priority) {
    const promoted = c.rank < priorityRank(ticket.priority);
    parts.push(`${en ? 'Priority' : 'Prioridad'} ${ticket.priority}${promoted ? (en ? ' (moved up for its age)' : ' (sube por antigüedad)') : ''}`);
  }
  if (age) parts.push(age);
  parts.push(c.estimate.basis === 'default' ? `${formatMinutes(c.estimate.minutes)}${en ? ' (no history yet)' : ' (sin historial aún)'}` : formatMinutes(c.estimate.minutes));
  if (c.waitsFor.length) parts.push(en ? `after ${c.waitsFor.join(', ')} (blocked by it)` : `después de ${c.waitsFor.join(', ')} (bloqueado por él)`);
  if (ticket.epic) parts.push(en ? `epic ${ticket.epic}` : `épica ${ticket.epic}`);
  if (c.envBlocked) parts.push(en ? 'last run BLOCKED by the environment: last' : 'último BLOCKED por el ambiente: al final');
  return parts.join(' · ');
}

// ── When things should start ──────────────────────────────────────────────────────────────────────

/** Pause between runs on a site, counted in the estimates (the server waits 30 s). */
const GAP_MIN = 0.5;

/**
 * Expected start of each run waiting on a site, after what runs there now, and when the site would
 * be free. `extra` adds runs not queued yet (the "Validate all" preview), after the queue.
 */
export function laneSchedule(
  state: Pick<AppState, 'jira' | 'automations' | 'queue' | 'settings'>,
  site: string,
  now = Date.now(),
  extra: Array<{ id: string; kind: Automation['kind']; target: string }> = [],
): { starts: Map<string, number>; freeAt: number } {
  const { qa } = state.settings;
  const typeOf = (key: string): string => state.jira.tickets.find((t) => t.key === key)?.type ?? '';
  const estimate = (kind: Automation['kind'], target: string, ticketType = ''): number =>
    estimateMinutes({ kind, ticketType: kind === 'orchestrator' ? ticketType || typeOf(target) : '', site }, state.automations, qa, typeOf).minutes;
  let at = now;
  const running = state.automations.find((a) => a.finishedAt === null && laneOf(a, qa) === site);
  // A running ticket may no longer be loaded from Jira: its own saved type is used.
  if (running) at += Math.max(1, estimate(running.kind, running.target, running.ticketType) - (now - running.startedAt) / 60_000) * 60_000;
  const starts = new Map<string, number>();
  for (const run of [...state.queue.items.filter((q) => q.site === site), ...extra]) {
    if (running || starts.size > 0) at += GAP_MIN * 60_000;
    starts.set(run.id, at);
    at += estimate(run.kind, run.target) * 60_000;
  }
  return { starts, freeAt: at };
}

/** Position of a queued run within its lane (1 = next). */
export const queuePosition = (items: QueueItem[], item: Pick<QueueItem, 'id' | 'site'>): number =>
  items.filter((q) => q.site === item.site).findIndex((q) => q.id === item.id) + 1;

/** Queued run of that kind and target, if any (to show "Queued · #2" on its button). */
export const queuedOf = (items: QueueItem[], kind: QueueItem['kind'], target?: string): QueueItem | undefined =>
  items.find((q) => q.kind === kind && (target === undefined || q.target === target));

/** Short reason for a queued ticket: "Priority High · created 12 d ago". */
export function ticketReason(ticket: JiraTicket, lang: Lang, now = Date.now()): string {
  const parts: string[] = [];
  if (ticket.priority) parts.push(lang === 'en' ? `Priority ${ticket.priority}` : `Prioridad ${ticket.priority}`);
  if (ticket.created !== null) {
    const days = Math.max(0, Math.floor((now - ticket.created) / DAY_MS));
    parts.push(lang === 'en' ? (days === 0 ? 'created today' : `created ${days} d ago`) : days === 0 ? 'creado hoy' : `creado hace ${days} d`);
  }
  return parts.join(' · ');
}

/** Site of a queued run, for display. */
export const queueSite = (item: QueueItem, qa: QaConfig): QaSite | undefined => findSite(item.site, qa);
