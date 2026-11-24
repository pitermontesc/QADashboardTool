import { findSite, siteForStatus } from './orchestrator.js';
import type { AppState, Automation, JiraTicket, Lang, QaConfig, QaSite, QueueItem } from './types.js';

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

/** Jira priority as a rank: 0 is the most urgent. Unknown names count as Medium. */
export function priorityRank(priority: string): number {
  const p = priority.trim().toLowerCase();
  if (/highest|blocker|critical|urgent/.test(p)) return 0;
  if (/lowest|trivial/.test(p)) return 4;
  if (/high/.test(p)) return 1;
  if (/low/.test(p)) return 3;
  return 2;
}

/**
 * Order of tickets in one lane (v1.15.0): the most urgent Jira priority first, then the oldest ticket
 * (so a low-priority ticket does not wait forever), then the key. Tickets with no known date go last.
 */
export function compareTickets(a: JiraTicket, b: JiraTicket): number {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    (a.created ?? Number.MAX_SAFE_INTEGER) - (b.created ?? Number.MAX_SAFE_INTEGER) ||
    a.key.localeCompare(b.key, 'en', { numeric: true })
  );
}

/** Staging first: it is the release gate, so a ticket waiting there blocks a deploy. */
export const isReleaseGate = (site: QaSite): boolean => /stg|stag/i.test(`${site.id} ${site.name} ${site.env}`);

/** Lanes in display order: release gate (STG) first, then the order in the settings. */
export function orderedSites(qa: QaConfig): QaSite[] {
  return [...qa.sites].sort((a, b) => Number(isReleaseGate(b)) - Number(isReleaseGate(a)));
}

export interface TicketCandidate {
  ticket: JiraTicket;
  site: QaSite;
  /** Last finished orchestrator run on the ticket, if any. */
  last: Automation | null;
  /** Selected by default: never validated, or its last run was BLOCKED (nothing was really tested). */
  suggested: boolean;
}

/**
 * Tickets that "Validate all" offers: in a status ready for the orchestrator, not running and not
 * queued already. Grouped by lane (STG first) and ordered within each lane by `compareTickets`.
 */
export function ticketsToValidate(state: Pick<AppState, 'jira' | 'automations' | 'queue' | 'settings'>): TicketCandidate[] {
  const { qa } = state.settings;
  const busy = new Set([
    ...state.automations.filter((a) => a.kind === 'orchestrator' && a.finishedAt === null).map((a) => a.target),
    ...state.queue.items.filter((q) => q.kind === 'orchestrator').map((q) => q.target),
  ]);
  const candidates: TicketCandidate[] = [];
  for (const ticket of state.jira.tickets) {
    const site = siteForStatus(ticket.status, qa);
    if (!site || busy.has(ticket.key)) continue;
    const last = state.automations
      .filter((a) => a.kind === 'orchestrator' && a.target === ticket.key && a.finishedAt !== null)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] ?? null;
    candidates.push({ ticket, site, last, suggested: !last || last.verdict === 'BLOCKED' });
  }
  const laneOrder = orderedSites(qa).map((s) => s.id);
  return candidates.sort((a, b) => laneOrder.indexOf(a.site.id) - laneOrder.indexOf(b.site.id) || compareTickets(a.ticket, b.ticket));
}

/** Position of a queued run within its lane (1 = next). */
export const queuePosition = (items: QueueItem[], item: Pick<QueueItem, 'id' | 'site'>): number =>
  items.filter((q) => q.site === item.site).findIndex((q) => q.id === item.id) + 1;

/** Queued run of that kind and target, if any (to show "Queued · #2" on its button). */
export const queuedOf = (items: QueueItem[], kind: QueueItem['kind'], target?: string): QueueItem | undefined =>
  items.find((q) => q.kind === kind && (target === undefined || q.target === target));

const DAY_MS = 24 * 60 * 60_000;

/** Why a ticket is where it is: "Priority High · created 12 d ago". */
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
