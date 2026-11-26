import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Store } from '../src/server/store';
import { priorityRank, ticketsToValidate } from '../src/shared/queue';
import type { ClaudeJob } from '../src/server/claudeRunner';
import type { Automation, JiraTicket } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.15.0): runs on the same QA site go one at a time (two runs on one site share Chrome,
 * the test users and the data). A run asked for while its site is busy waits in that site's queue
 * and starts by itself, after a short pause, when the site is free; another site runs in parallel.
 * "Validate all" queues the chosen tickets: within each site the most urgent Jira priority first,
 * then the oldest ticket. Nothing in the queue starts without having been asked for.
 */

/** Jira with tickets the test can change: [key, status, priority, created]. */
const tickets: Array<[string, string, string, string]> = [
  ['AVM-1', 'On QA', 'Medium', '2026-11-01T10:00:00.000-0500'],
  ['AVM-2', 'On QA', 'Highest', '2026-11-20T10:00:00.000-0500'],
  ['AVM-3', 'On QA', 'Medium', '2026-10-01T10:00:00.000-0500'],
  ['AVM-4', 'On Staging', 'Low', '2026-11-05T10:00:00.000-0500'],
  ['AVM-5', 'Test', 'Highest', '2026-11-05T10:00:00.000-0500'],
];
const jira: typeof fetch = async () =>
  Response.json({
    issues: tickets.map(([key, status, priority, created]) => ({
      key,
      fields: { summary: `Ticket ${key}`, status: { name: status }, issuetype: { name: 'Story' }, priority: { name: priority }, created },
    })),
  });

describe('One run at a time per site', () => {
  const jobs: ClaudeJob[] = [];
  /** While set, Claude Code fails to start (as when it is not installed). */
  let launchFails = false;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: jira,
      launchClaude: async (job) => {
        if (launchFails) throw new Error('Claude Code (claude) was not found on this Mac');
        jobs.push(job);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());
  afterEach(async () => {
    launchFails = false;
    await srv.call('POST', '/api/queue/resume', { site: 'qa' });
    await srv.reset();
  });

  const state = async () => (await srv.call('GET', '/api/state')).body;
  const inProgress = async (): Promise<string[]> =>
    (await state()).automations.filter((a: Automation) => a.finishedAt === null).map((a: Automation) => a.target);
  const queued = async (): Promise<string[]> => (await state()).queue.items.map((q: { target: string }) => q.target);
  const finish = async (target: string, verdict = 'PASSED') => {
    const a = (await state()).automations.find((x: Automation) => x.target === target && x.finishedAt === null);
    return srv.call('POST', `/api/automation/${a.id}/result`, { verdict, summary: 'Done' });
  };

  it('a second run on a busy site waits and starts by itself when the site is free; another site runs meanwhile', async () => {
    expect((await srv.call('POST', '/api/orchestrator/AVM-1', {})).status).toBe(200);
    const second = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ queued: { kind: 'smoke', target: 'QA', site: 'qa' }, position: 1 });
    // STG is another lane: it does not wait.
    expect((await srv.call('POST', '/api/orchestrator/AVM-4', {})).status).toBe(200);
    expect((await inProgress()).sort()).toEqual(['AVM-1', 'AVM-4']);

    await finish('AVM-1');
    await expect.poll(inProgress).toContain('QA');
    expect(await queued()).toEqual([]);
    expect(jobs.at(-1)!.prompt).toContain('smoke-tester run smoke on QA');
  });

  it('"Validate all" queues the chosen tickets per site: highest priority first, then the oldest', async () => {
    const { status, body } = await srv.call('POST', '/api/queue', { keys: ['AVM-1', 'AVM-2', 'AVM-3', 'AVM-4', 'AVM-5'] });
    expect(status).toBe(200);
    // The first of each site starts now; AVM-5 ("Test") is not ready and is left out.
    expect(body.automations.filter((a: Automation) => a.finishedAt === null).map((a: Automation) => a.target).sort()).toEqual(['AVM-2', 'AVM-4']);
    expect(body.queue.items.map((q: { target: string }) => q.target)).toEqual(['AVM-3', 'AVM-1']);

    await finish('AVM-2');
    await expect.poll(inProgress).toContain('AVM-3');
    await finish('AVM-3', 'FAILED');
    await expect.poll(inProgress).toContain('AVM-1');
    expect(await queued()).toEqual([]);
  });

  it('the queue can be reordered within a site and a run taken out of it', async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' }); // Takes the QA lane.
    await srv.call('POST', '/api/queue', { keys: ['AVM-1', 'AVM-2', 'AVM-3'] });
    expect(await queued()).toEqual(['AVM-2', 'AVM-3', 'AVM-1']);
    const items = (await state()).queue.items;
    await srv.call('POST', `/api/queue/${items[2].id}/move`, { direction: 'up' });
    expect(await queued()).toEqual(['AVM-2', 'AVM-1', 'AVM-3']);
    expect((await srv.call('DELETE', `/api/queue/${items[0].id}`)).status).toBe(200);
    expect(await queued()).toEqual(['AVM-1', 'AVM-3']);
    // A ticket already queued is not queued twice.
    expect((await srv.call('POST', '/api/orchestrator/AVM-1', {})).status).toBe(409);
  });

  it('a queued ticket that left its Jira status is dropped when its turn comes, saying why', async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', '/api/queue', { keys: ['AVM-3'] });
    tickets[2]![1] = 'Passed QA';
    await srv.call('POST', '/api/jira/refresh', {});
    try {
      await finish('QA', 'GO');
      await expect.poll(queued).toEqual([]);
      expect(await inProgress()).toEqual([]);
      expect((await state()).queue.skipped[0]).toMatchObject({ target: 'AVM-3', reason: expect.stringContaining('Passed QA') });
    } finally {
      tickets[2]![1] = 'On QA';
      await srv.call('POST', '/api/jira/refresh', {});
    }
  });

  it('if Claude cannot start, the site stops with the run first in line, and Resume starts it', async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', '/api/queue', { keys: ['AVM-1'] });
    launchFails = true;
    await finish('QA', 'GO');
    await expect.poll(async () => (await state()).queue.paused.qa).toMatch(/No se encontró Claude Code/);
    expect(await queued()).toEqual(['AVM-1']);

    launchFails = false;
    await srv.call('POST', '/api/queue/resume', { site: 'qa' });
    await expect.poll(inProgress).toEqual(['AVM-1']);
  });
});

describe('Queue timing and restarts', () => {
  it('waits the pause after a run before starting the next one on the same site', async () => {
    const srv = await startServer({ laneGapMs: 400, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    const { body: first } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect((await srv.call('POST', '/api/regression', { run: '#b333fb92' })).status).toBe(200); // STG, free
    await srv.call('POST', '/api/smoke', { site: 'stg' }); // Waits for the regression.
    const { body: done } = await srv.call('GET', '/api/state');
    const regression = done.automations.find((a: Automation) => a.kind === 'regression');
    await srv.call('POST', `/api/automation/${regression.id}/result`, { verdict: 'GO' });
    const started = async () => (await srv.call('GET', '/api/state')).body.automations.some((a: Automation) => a.target === 'STG');
    expect(await started()).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await started()).toBe(false);
    await expect.poll(started, { timeout: 2000 }).toBe(true);
    await srv.call('POST', `/api/automation/${first.id}/stop`, {});
    await srv.reset();
    await srv.close();
  });

  it('the queue is kept across a restart and goes on once the app opens', async () => {
    const first = await startServer({ launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    const { body: running } = await first.call('POST', '/api/smoke', { site: 'qa' });
    expect((await first.call('POST', '/api/regression', { run: '#b333fb92' })).status).toBe(200);
    expect((await first.call('POST', '/api/smoke', { site: 'stg' })).status).toBe(202);
    await first.close();

    // The app restarts: the smoke on QA is closed (its Claude is gone), the queued STG smoke is still there.
    const launched: string[] = [];
    const app = createApp(new Store(first.file), {
      processAlive: () => false,
      laneGapMs: 0,
      launchClaude: async (job) => {
        launched.push(job.prompt);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // Opening the app (its first request) lets the queue go on: the regression was closed, so STG is free.
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.automations.find((a: Automation) => a.id === running.id).verdict).toBe('BLOCKED');
      await expect.poll(() => launched.length).toBe(1);
      expect(launched[0]).toContain('smoke on STG');
      expect((await (await fetch(`${base}/api/state`)).json()).queue.items).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('Which tickets "Validate all" offers', () => {
  const ticket = (key: string, status: string, priority = '', created: number | null = null): JiraTicket => ({
    key, summary: key, status, type: 'Story', priority, created, epic: '', blockedBy: [],
  });
  const settings = { qa: { sites: [
    { id: 'qa', name: 'QA', url: 'https://qa.example', env: 'QA', jiraStatus: 'On QA' },
    { id: 'stg', name: 'STG', url: 'https://stg.example', env: 'STG', jiraStatus: 'On Staging' },
  ], regressionSiteId: 'stg', skills: { orchestrator: '', smoke: '', regression: '' }, testRunHosts: [] } } as never;
  const finished = (target: string, verdict: Automation['verdict']) => ({ kind: 'orchestrator', target, finishedAt: 1, verdict }) as Automation;

  it('offers ready tickets not running or queued, STG first, and suggests the ones never validated or blocked', () => {
    const candidates = ticketsToValidate({
      settings,
      jira: { tickets: [ticket('AVM-1', 'On QA'), ticket('AVM-2', 'On QA'), ticket('AVM-3', 'On QA'), ticket('AVM-4', 'On Staging'), ticket('AVM-5', 'In Progress'), ticket('AVM-6', 'On QA')] } as never,
      automations: [finished('AVM-1', 'PASSED'), finished('AVM-2', 'BLOCKED'), { kind: 'orchestrator', target: 'AVM-3', finishedAt: null } as Automation],
      queue: { items: [{ id: 'q', kind: 'orchestrator', target: 'AVM-6', site: 'qa', dryRun: false, fullCoverage: false, addedAt: 0, batch: 'b', retries: 0 }], paused: {}, skipped: [], finished: [] },
    });
    expect(candidates.map((c) => [c.ticket.key, c.site.id, c.suggested])).toEqual([
      ['AVM-4', 'stg', true],
      ['AVM-1', 'qa', false], // Validated already (PASSED): offered, not suggested.
      ['AVM-2', 'qa', true], // Its last run was BLOCKED: nothing was really tested.
    ]);
  });

  it('reads Jira priorities by name, with unknown ones as Medium', () => {
    expect(['Highest', 'Blocker', 'High', 'Medium', '', 'Low', 'Lowest'].map(priorityRank)).toEqual([0, 0, 1, 2, 2, 3, 4]);
  });
});
