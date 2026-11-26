import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { ORCHESTRATOR_FULL_COVERAGE } from '../src/shared/orchestrator';
import type { ClaudeJob } from '../src/server/claudeRunner';
import type { Automation } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.18.0): the orchestrator can be launched with full coverage. Claude then gets the
 * skill, the ticket and a request to run every agent of the skill whatever the ticket size; the run
 * is marked as full coverage, and so is its place in the queue and its automatic retry. Without it,
 * the prompt is the usual one. Data from earlier versions has no full coverage.
 */
const jira: typeof fetch = async () =>
  Response.json({
    issues: [
      ['AVM-1', 'On QA'],
      ['AVM-2', 'On QA'],
    ].map(([key, status]) => ({
      key,
      fields: { summary: `Ticket ${key}`, status: { name: status }, issuetype: { name: 'Bug' }, priority: { name: 'Medium' }, created: '2026-11-01T10:00:00.000-0500' },
    })),
  });

describe('Orchestrator with full coverage', () => {
  const jobs: ClaudeJob[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: jira,
      launchClaude: async (job) => {
        jobs.push(job);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());
  afterEach(async () => {
    jobs.length = 0;
    await srv.call('POST', '/api/queue/resume', { site: 'qa' });
    await srv.reset();
  });

  const state = async () => (await srv.call('GET', '/api/state')).body;
  const running = async (target: string): Promise<Automation> =>
    (await state()).automations.find((a: Automation) => a.target === target && a.finishedAt === null);

  it('asks Claude for every agent, right after the ticket, and marks the run', async () => {
    const { status, body: a } = await srv.call('POST', '/api/orchestrator/AVM-1', { fullCoverage: true });
    expect(status).toBe(200);
    expect(a.fullCoverage).toBe(true);
    const prompt = jobs.at(-1)!.prompt;
    expect(prompt.startsWith(`/avm-qa-skills:avm-qa-orchestrator AVM-1 -- FULL COVERAGE:`)).toBe(true);
    expect(prompt).toContain('run the full M pipeline with every agent');
    expect(prompt).toContain('A3 impact reviewer');
    expect(prompt).toContain('A5 regression runner as its own agent');
    expect(prompt).toContain('Do not merge or skip an agent');
    // The report instruction still follows, so Claude reports to the dashboard.
    expect(prompt).toContain(`/api/automation/${a.id}/result`);
  });

  it('without full coverage (or with anything but true) the prompt and the run are the usual ones', async () => {
    const { body: plain } = await srv.call('POST', '/api/orchestrator/AVM-1', {});
    expect(plain.fullCoverage).toBe(false);
    expect(jobs.at(-1)!.prompt).not.toContain('FULL COVERAGE');
    expect(jobs.at(-1)!.prompt.startsWith('/avm-qa-skills:avm-qa-orchestrator AVM-1 -- ')).toBe(true);
    await srv.call('POST', `/api/automation/${plain.id}/result`, { verdict: 'PASSED', summary: 'Done' }); // Frees the QA site.

    const { body: other } = await srv.call('POST', '/api/orchestrator/AVM-2', { fullCoverage: 'yes' });
    expect(other.fullCoverage).toBe(false);
    expect(jobs.at(-1)!.prompt).not.toContain(ORCHESTRATOR_FULL_COVERAGE);
  });

  it('keeps full coverage while it waits in the queue and in its retry after an environment block', async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' }); // QA is busy.
    const waiting = await srv.call('POST', '/api/orchestrator/AVM-1', { fullCoverage: true });
    expect(waiting.status).toBe(202);
    expect(waiting.body.queued).toMatchObject({ target: 'AVM-1', fullCoverage: true });

    const smoke = await running('QA');
    await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'GO', summary: 'Done' });
    await expect.poll(async () => (await running('AVM-1'))?.fullCoverage).toBe(true);
    expect(jobs.at(-1)!.prompt).toContain(ORCHESTRATOR_FULL_COVERAGE);

    const first = await running('AVM-1');
    await srv.call('POST', `/api/automation/${first.id}/result`, { verdict: 'BLOCKED', summary: 'Could not sign in to qa.alpinevm.com' });
    await expect.poll(async () => (await running('AVM-1'))?.id ?? null).not.toBeNull();
    const retry = await running('AVM-1');
    expect(retry.id).not.toBe(first.id);
    expect(retry.fullCoverage).toBe(true);
    expect(jobs.at(-1)!.prompt).toContain(ORCHESTRATOR_FULL_COVERAGE);
  });
});

describe('Data saved before full coverage', () => {
  it('runs and queued runs from earlier versions have no full coverage', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
    const automation = {
      id: 'a1', kind: 'orchestrator', target: 'AVM-1', env: 'QA', title: 'Orquestador QA: x', startedAt: 1, finishedAt: 2, verdict: 'PASSED',
      summary: '', link: '', details: null, runId: null, lang: 'es', translations: {}, dryRun: false, site: 'qa', ticketType: 'Bug', queued: null,
    };
    const queueItem = { id: 'q1', kind: 'orchestrator', target: 'AVM-2', site: 'qa', dryRun: false, addedAt: 0, batch: 'b', retries: 0 };
    writeFileSync(file, JSON.stringify({ version: 1, runs: [], automations: [automation], queue: { items: [queueItem], paused: {}, skipped: [], finished: [] } }));
    const { automations, queue } = new Store(file).getState();
    expect(automations[0]!.fullCoverage).toBe(false);
    expect(queue.items[0]!.fullCoverage).toBe(false);
  });
});
