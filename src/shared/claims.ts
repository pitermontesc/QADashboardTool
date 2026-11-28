import { formatDmy, toYmd } from './dates.js';
import type { Automation, Lang, QaSite, TeamMember, TicketClaim } from './types.js';

/**
 * Teammates' work on tickets, read from the team folder, so two QAs do not validate the same ticket
 * at the same time or again right after each other.
 */

/**
 * A teammate's running and queued runs count only while their file is this recent: a live app
 * writes it at least every hour, so an older one means their app is closed or not syncing.
 */
export const CLAIM_FRESH_MS = 2 * 60 * 60_000;

/** Everything teammates are doing on tickets with the orchestrator. Test-mode runs validate nothing. */
export function teamClaims(members: Pick<TeamMember, 'name' | 'me' | 'updatedAt' | 'automations' | 'queue'>[], now = Date.now()): TicketClaim[] {
  const claims: TicketClaim[] = [];
  for (const m of members) {
    if (m.me) continue;
    const runs = m.automations.filter((a) => a.kind === 'orchestrator');
    if (now - m.updatedAt <= CLAIM_FRESH_MS) {
      for (const a of runs) {
        if (a.finishedAt === null) claims.push({ key: a.target, state: 'running', by: m.name, at: a.startedAt, verdict: null, site: a.site, env: a.env });
      }
      for (const q of m.queue) {
        if (q.kind === 'orchestrator') claims.push({ key: q.target, state: 'queued', by: m.name, at: q.addedAt, verdict: null, site: q.site, env: '' });
      }
    }
    // Their newest finished run of each ticket on each site: if it was BLOCKED, nothing was tested.
    const newest = new Map<string, Automation>();
    for (const a of runs) {
      if (a.finishedAt === null || a.dryRun) continue;
      const k = `${a.target}\n${a.site || a.env}`;
      const known = newest.get(k);
      if (!known || known.finishedAt! < a.finishedAt) newest.set(k, a);
    }
    for (const a of newest.values()) {
      if (a.verdict && a.verdict !== 'BLOCKED') claims.push({ key: a.target, state: 'validated', by: m.name, at: a.finishedAt!, verdict: a.verdict, site: a.site, env: a.env });
    }
  }
  return claims;
}

/** The run was on this site: same site id, or same environment (site ids can differ between Macs). */
const onSite = (c: TicketClaim, site: QaSite): boolean => c.site === site.id || (c.env !== '' && c.env === site.env);

/**
 * What matters about a ticket before validating it here: a teammate validating it now, then one
 * with it queued, then the newest validation on the site it would run on, if newer than this app's
 * own last run of it (`ownLastAt`).
 */
export function claimFor(claims: TicketClaim[], key: string, site: QaSite | null, ownLastAt: number | null = null): TicketClaim | null {
  const mine = claims.filter((c) => c.key === key);
  return (
    mine.find((c) => c.state === 'running') ??
    mine.find((c) => c.state === 'queued') ??
    mine
      .filter((c) => c.state === 'validated' && site !== null && onSite(c, site) && (ownLastAt === null || c.at > ownLastAt))
      .sort((a, b) => b.at - a.at)[0] ??
    null
  );
}

/** "Luis Torres is validating it · 12 min", "In Marta Gómez's queue", "Marta Gómez validated it on 11/25/2026: PASSED". */
export function claimText(c: TicketClaim, lang: Lang, now = Date.now()): string {
  const en = lang === 'en';
  if (c.state === 'running') {
    const min = Math.max(0, Math.floor((now - c.at) / 60_000));
    return en ? `${c.by} is validating it · ${min} min` : `${c.by} lo está validando · ${min} min`;
  }
  if (c.state === 'queued') return en ? `In ${c.by}'s queue` : `En la cola de ${c.by}`;
  const date = formatDmy(toYmd(new Date(c.at)), lang);
  return en ? `${c.by} validated it on ${date}: ${c.verdict}` : `${c.by} lo validó el ${date}: ${c.verdict}`;
}

/** When this app last validated a ticket with the orchestrator (a BLOCKED run tested nothing); null if never. */
export function ownLastValidation(automations: Automation[], key: string): number | null {
  let last: number | null = null;
  for (const a of automations) {
    if (a.kind === 'orchestrator' && a.target === key && a.finishedAt !== null && a.verdict !== 'BLOCKED' && (last === null || a.finishedAt > last)) last = a.finishedAt;
  }
  return last;
}
