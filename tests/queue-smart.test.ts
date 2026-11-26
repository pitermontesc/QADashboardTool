import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  candidateReason, effectiveRank, estimateMinutes, priorityRank, isEnvironmentBlock, isUsageLimit, laneSchedule, orderLane, type TicketCandidate,
} from '../src/shared/queue';
import { defaultQaConfig } from '../src/shared/orchestrator';
import type { Automation, JiraTicket } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.15.1): within a site, tickets last BLOCKED by the environment go last; then the most
 * urgent Jira priority (moved up one level every 30 days of age); then the shortest expected run
 * (median of earlier runs of the same ticket type); then the oldest. Tickets of one epic go together,
 * and a ticket "blocked by" another goes after it. A queued ticket BLOCKED by the environment is
 * retried once; two such runs in a row pause the site; Claude's usage limit pauses every site with
 * runs waiting; and a finished batch leaves a summary.
 */
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const qa = defaultQaConfig();
const site = qa.sites[0]!;

const ticket = (key: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key, summary: key, status: 'On QA', type: 'Story', priority: 'Medium', created: NOW - DAY, epic: '', blockedBy: [], ...over,
});
const candidate = (t: JiraTicket, over: Partial<TicketCandidate> = {}): TicketCandidate => ({
  ticket: t, site, last: null, suggested: true, estimate: { minutes: 30, basis: 'kind' }, rank: effectiveRank(t, NOW), envBlocked: false, waitsFor: [], ...over,
});
const keys = (list: TicketCandidate[]) => list.map((c) => c.ticket.key);
const run = (over: Partial<Automation>): Automation =>
  ({ kind: 'orchestrator', target: 'X', env: 'QA', site: 'qa', ticketType: '', startedAt: 0, finishedAt: 30 * 60_000, verdict: 'PASSED', summary: '', queued: null, ...over }) as Automation;

describe('Order within a site', () => {
  it('most urgent priority first, then the shortest expected run, then the oldest', () => {
    const list = [
      candidate(ticket('AVM-1', { priority: 'Low' })),
      candidate(ticket('AVM-2', { priority: 'High' }), { estimate: { minutes: 50, basis: 'similar' } }),
      candidate(ticket('AVM-3', { priority: 'High' }), { estimate: { minutes: 20, basis: 'similar' } }),
      candidate(ticket('AVM-4', { priority: 'High', created: NOW - 5 * DAY }), { estimate: { minutes: 20, basis: 'similar' } }),
    ];
    expect(keys(orderLane(list))).toEqual(['AVM-4', 'AVM-3', 'AVM-2', 'AVM-1']);
  });

  it('an old ticket moves up one priority level every 30 days', () => {
    expect(effectiveRank(ticket('A', { priority: 'Low', created: NOW - 65 * DAY }), NOW)).toBe(1); // Low → High
    expect(effectiveRank(ticket('B', { priority: 'Low', created: NOW - 10 * DAY }), NOW)).toBe(3);
    expect(effectiveRank(ticket('C', { priority: 'Highest', created: NOW - 400 * DAY }), NOW)).toBe(0);
    const old = candidate(ticket('AVM-OLD', { priority: 'Low', created: NOW - 65 * DAY }));
    expect(candidateReason(old, 'es', NOW)).toContain('Prioridad Low (sube por antigüedad)');
  });

  it('a ticket last BLOCKED by the environment goes last, whatever its priority', () => {
    const list = [candidate(ticket('AVM-1', { priority: 'Highest' }), { envBlocked: true }), candidate(ticket('AVM-2', { priority: 'Lowest' }))];
    expect(keys(orderLane(list))).toEqual(['AVM-2', 'AVM-1']);
  });

  it('tickets of the same epic go together, where the first of them is', () => {
    const list = [
      candidate(ticket('AVM-1', { priority: 'Highest', epic: 'E-1' })),
      candidate(ticket('AVM-2', { priority: 'High' })),
      candidate(ticket('AVM-3', { priority: 'Low', epic: 'E-1' })),
    ];
    expect(keys(orderLane(list))).toEqual(['AVM-1', 'AVM-3', 'AVM-2']);
  });

  it('a ticket blocked by another one in the list goes after it', () => {
    const list = [
      candidate(ticket('AVM-1', { priority: 'Highest' }), { waitsFor: ['AVM-3'] }),
      candidate(ticket('AVM-2', { priority: 'High' })),
      candidate(ticket('AVM-3', { priority: 'Low' })),
    ];
    const ordered = orderLane(list);
    expect(keys(ordered)).toEqual(['AVM-2', 'AVM-3', 'AVM-1']);
    expect(candidateReason(ordered[2]!, 'es', NOW)).toContain('después de AVM-3 (bloqueado por él)');
    // A cycle in Jira does not hang the ordering.
    expect(keys(orderLane([candidate(ticket('A'), { waitsFor: ['B'] }), candidate(ticket('B'), { waitsFor: ['A'] })])).sort()).toEqual(['A', 'B']);
  });
});

describe('Jira priority schemes', () => {
  it('reads numbered priorities (1 the most urgent, as in AVM) like named ones', () => {
    expect(['1', '2', '3', '4', '5', 'P1', 'p5', '9'].map(priorityRank)).toEqual([0, 1, 2, 3, 4, 0, 4, 4]);
    const list = [candidate(ticket('AVM-5', { priority: '5' })), candidate(ticket('AVM-2', { priority: '2' })), candidate(ticket('AVM-3', { priority: '3' }))];
    expect(keys(orderLane(list.map((c) => ({ ...c, rank: effectiveRank(c.ticket, NOW) }))))).toEqual(['AVM-2', 'AVM-3', 'AVM-5']);
  });
});

describe('Expected duration', () => {
  const history = [
    run({ target: 'AVM-1', ticketType: 'Bug', finishedAt: 10 * 60_000 }),
    run({ target: 'AVM-2', ticketType: 'Bug', finishedAt: 20 * 60_000 }),
    run({ target: 'AVM-3', ticketType: 'Story', finishedAt: 60 * 60_000 }),
    run({ target: 'AVM-4', ticketType: 'Bug', finishedAt: 2 * 60_000, verdict: 'BLOCKED' }), // Ends early: not counted.
  ];
  it('is the median of earlier runs of the same ticket type, else of the kind, else a default', () => {
    expect(estimateMinutes({ kind: 'orchestrator', ticketType: 'Bug' }, history, qa)).toEqual({ minutes: 15, basis: 'similar' });
    expect(estimateMinutes({ kind: 'orchestrator', ticketType: 'Story' }, history, qa)).toEqual({ minutes: 20, basis: 'kind' });
    expect(estimateMinutes({ kind: 'orchestrator', ticketType: 'Bug' }, [], qa)).toEqual({ minutes: 30, basis: 'default' });
    expect(estimateMinutes({ kind: 'regression', site: 'stg' }, [], qa).minutes).toBe(90);
  });

  it('a site queue starts each run after the one before, counting what runs now', () => {
    const state = {
      settings: { qa } as never,
      jira: { tickets: [ticket('AVM-9', { type: 'Bug' })] } as never,
      automations: [...history, run({ target: 'AVM-8', ticketType: 'Bug', startedAt: NOW - 5 * 60_000, finishedAt: null, verdict: null })],
      queue: { items: [{ id: 'q1', kind: 'orchestrator' as const, target: 'AVM-9', site: 'qa', dryRun: false, fullCoverage: false, addedAt: 0, batch: 'b', retries: 0 }], paused: {}, skipped: [], finished: [] },
    };
    const { starts, freeAt } = laneSchedule(state, 'qa', NOW);
    // The running Bug has ~10 of its 15 min left, then the 30 s pause, then 15 min for AVM-9.
    expect((starts.get('q1')! - NOW) / 60_000).toBe(10.5);
    expect((freeAt - NOW) / 60_000).toBe(25.5);
  });
});

describe('What a BLOCKED run says about the site', () => {
  it('tells the environment (site, login, browser, Claude gone) from the ticket and from a stop', () => {
    const blocked = (summary: string) => ({ verdict: 'BLOCKED' as const, summary });
    expect(isEnvironmentBlock(blocked('Could not sign in to staging: SSO returned 502'))).toBe(true);
    expect(isEnvironmentBlock(blocked('Claude in Chrome no estaba conectado'))).toBe(true);
    expect(isEnvironmentBlock(blocked('Claude terminó sin reportar el resultado (código de salida 1).'))).toBe(true);
    expect(isEnvironmentBlock(blocked('The ticket has no acceptance criteria to test.'))).toBe(false);
    expect(isEnvironmentBlock(blocked('Detenida desde QA Dashboard.'))).toBe(false);
    expect(isEnvironmentBlock({ verdict: 'FAILED', summary: 'Login button broken' })).toBe(false);
    expect(isUsageLimit(blocked('Claude AI usage limit reached|1795600000'))).toBe(true);
  });
});

describe('The queue reacts to how runs end', () => {
  const tickets: Array<[string, string, string]> = [
    ['AVM-1', 'On QA', 'Highest'],
    ['AVM-2', 'On QA', 'High'],
    ['AVM-3', 'On QA', 'Medium'],
    ['AVM-4', 'On Staging', 'Medium'],
  ];
  const jira: typeof fetch = async () =>
    Response.json({
      issues: tickets.map(([key, status, priority]) => ({
        key, fields: { summary: key, status: { name: status }, issuetype: { name: 'Bug' }, priority: { name: priority }, created: '2026-11-20T10:00:00.000-0500' },
      })),
    });
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());
  afterEach(async () => {
    for (const site of ['qa', 'stg']) await srv.call('POST', '/api/queue/resume', { site });
    await srv.reset();
  });

  const state = async () => (await srv.call('GET', '/api/state')).body;
  const inProgress = async (): Promise<string[]> => (await state()).automations.filter((a: Automation) => a.finishedAt === null).map((a: Automation) => a.target);
  const queued = async (): Promise<string[]> => (await state()).queue.items.map((q: { target: string }) => q.target);
  const finish = async (target: string, verdict: string, summary = 'Done') => {
    const a = (await state()).automations.find((x: Automation) => x.target === target && x.finishedAt === null);
    expect(a, `${target} should be running`).toBeTruthy();
    return srv.call('POST', `/api/automation/${a.id}/result`, { verdict, summary });
  };

  it('a ticket BLOCKED by the environment is retried once at the end, and the batch leaves a summary', async () => {
    await srv.call('POST', '/api/queue', { keys: ['AVM-1', 'AVM-2', 'AVM-3'] });
    expect(await inProgress()).toEqual(['AVM-1']);
    await finish('AVM-1', 'BLOCKED', 'Could not sign in to qa.alpinevm.com');
    expect(await queued()).toEqual(['AVM-3', 'AVM-1']);
    await finish('AVM-2', 'PASSED');
    await finish('AVM-3', 'FAILED');
    expect(await inProgress()).toEqual(['AVM-1']); // The retry.
    await finish('AVM-1', 'BLOCKED', 'Could not sign in to qa.alpinevm.com');
    expect(await queued()).toEqual([]); // Not a second time.
    const [done] = (await state()).queue.finished;
    expect(done.verdicts).toEqual({ PASSED: 1, FAILED: 1, BLOCKED: 1 }); // AVM-1 counts once.
  });

  it('two runs in a row BLOCKED by the environment pause the site; Resume lets it go on', async () => {
    await srv.call('POST', '/api/queue', { keys: ['AVM-1', 'AVM-2', 'AVM-3'] });
    // AVM-1 was last BLOCKED by the environment (previous test): it goes last.
    expect(await inProgress()).toEqual(['AVM-2']);
    expect(await queued()).toEqual(['AVM-3', 'AVM-1']);
    await finish('AVM-2', 'BLOCKED', 'qa.alpinevm.com timed out');
    await finish('AVM-3', 'BLOCKED', 'The site is down (503)');
    const { queue } = await state();
    expect(queue.paused.qa).toMatch(/2 ejecuciones seguidas quedaron BLOCKED por el ambiente/);
    expect(await inProgress()).toEqual([]);
    expect(await queued()).toEqual(['AVM-1', 'AVM-2', 'AVM-3']); // Both retries wait behind AVM-1.

    await srv.call('POST', '/api/queue/resume', { site: 'qa' });
    expect(await inProgress()).toEqual(['AVM-1']);
    // The blocks before Resume no longer count: one more does not pause it again.
    await finish('AVM-1', 'BLOCKED', 'qa.alpinevm.com timed out');
    expect((await state()).queue.paused.qa).toBeUndefined();
  });

  it("Claude's usage limit pauses every site with runs waiting, and that run is not retried", async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', '/api/queue', { keys: ['AVM-1', 'AVM-4'] }); // AVM-1 waits on QA; AVM-4 runs on STG.
    await srv.call('POST', '/api/smoke', { site: 'stg' }); // Waits on STG.
    await finish('AVM-4', 'BLOCKED', 'Claude AI usage limit reached|1795600000');
    const { queue } = await state();
    expect(queue.paused.stg).toMatch(/límite de uso/);
    expect(queue.paused.qa).toMatch(/límite de uso/);
    expect(await queued()).toEqual(['AVM-1', 'STG']);
    await finish('QA', 'GO');
    expect(await inProgress()).toEqual([]);
  });
});
