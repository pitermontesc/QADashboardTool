import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { countedRuns, summarize } from '../src/shared/stats';
import type { TestRun } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.17.0, CHANGELOG / USER-GUIDE "Test mode"): a run in test mode is a rehearsal. Its
 * record says so (`testMode`), stays in Runs with its report, and the dashboard's numbers leave it
 * out. Records from earlier versions are marked when their report was in test mode; a mark set
 * (or cleared) by hand is kept.
 */
const RUN = { date: '2026-11-17', typeId: 't0', title: 'Smoke release', result: 'passed', passed: 20, failed: 0 };
type Row = { id: string; testMode: boolean; title: string };

describe('Runs in test mode (API)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
  });
  afterEach(() => srv.reset());
  afterAll(() => srv.close());
  const runOf = async (id: string): Promise<Row> => (await srv.call('GET', '/api/state')).body.runs.find((r: Row) => r.id === id);

  it('the record of a regression in test mode is a rehearsal, while it runs and once it reports', async () => {
    const { body: a } = await srv.call('POST', '/api/regression', { run: '#b333fb92', dryRun: true });
    expect((await runOf(a.runId)).testMode).toBe(true);
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'NO-GO', summary: 'x', passed: 38, failed: 2, blocked: 112 });
    expect(await runOf(a.runId)).toMatchObject({ testMode: true, blocked: 112 });
  });

  it('a regular regression or smoke counts', async () => {
    const { body: reg } = await srv.call('POST', '/api/regression', { run: '#beef1234' });
    expect((await runOf(reg.runId)).testMode).toBe(false);
    await srv.reset();
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect((await runOf(smoke.runId)).testMode).toBe(false);
  });

  it('a record can be marked or unmarked by hand, and counts unless marked', async () => {
    const { body: plain } = await srv.call('POST', '/api/runs', RUN);
    expect(plain.testMode).toBe(false);
    const { body: marked } = await srv.call('POST', '/api/runs', { ...RUN, testMode: true });
    expect(marked.testMode).toBe(true);
    const { body: cleared } = await srv.call('PUT', `/api/runs/${marked.id}`, { ...RUN, testMode: false });
    expect(cleared.testMode).toBe(false);
    expect((await srv.call('POST', '/api/runs', { ...RUN, testMode: 'yes' })).status).toBe(400);
  });

  it('importing a backup from before v1.17.0 marks the records of its test-mode reports, and keeps a mark already set', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const old = { ...RUN, createdAt: 1, notes: '', ticket: '', env: 'STG', blocked: 0, bugs: 0, minutes: 5 };
    const report = (id: string, runId: string, dryRun: boolean) => ({
      id, kind: 'regression', target: '#b333fb92', env: 'STG', title: 'Regression', startedAt: 1, finishedAt: 2, verdict: 'NO-GO',
      summary: '', link: '', details: null, runId, pid: null, logFile: '', lang: 'es', translations: {}, dryRun,
    });
    const backup = {
      ...state.settings,
      runs: [{ ...old, id: 'rehearsal' }, { ...old, id: 'real' }, { ...old, id: 'unmarked', testMode: false }],
      automations: [report('a1', 'rehearsal', true), report('a2', 'real', false), report('a3', 'unmarked', true)],
    };
    expect((await srv.call('POST', '/api/import', backup)).status).toBe(200);
    expect(Object.fromEntries((await srv.call('GET', '/api/state')).body.runs.map((r: Row) => [r.id, r.testMode]))).toEqual({
      rehearsal: true, real: false, unmarked: false,
    });
  });
});

describe('Data saved before v1.17.0', () => {
  it('marks the record of a report in test mode when the data is opened', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-tm-')), 'qa-tests.json');
    const run = (id: string) => ({ id, createdAt: 1, ...RUN, ticket: '', env: 'STG', blocked: 0, bugs: 0, minutes: 5, notes: '' });
    writeFileSync(file, JSON.stringify({
      version: 1,
      runs: [run('rehearsal'), run('manual')],
      automations: [{ id: 'a1', kind: 'regression', target: '#x', env: 'STG', title: 'R', startedAt: 1, finishedAt: 2, verdict: 'GO', summary: '', link: '', details: null, runId: 'rehearsal', dryRun: true }],
    }));
    const runs = new Store(file).getState().runs;
    expect(Object.fromEntries(runs.map((r) => [r.id, r.testMode]))).toEqual({ rehearsal: true, manual: false });
  });
});

describe('Dashboard numbers', () => {
  const row = (id: string, overrides: Partial<TestRun>): TestRun => ({
    id, createdAt: 1, date: '2026-11-17', typeId: 't0', title: id, ticket: '', env: 'STG', result: 'passed',
    passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '', testMode: false, ...overrides,
  });

  it('leave rehearsals out of the pass rate, cases, bugs and time', () => {
    const smoke = row('smoke', { passed: 20, failed: 0, blocked: 0, bugs: 0, minutes: 6 });
    const rehearsal = row('rehearsal', { result: 'failed', passed: 38, failed: 2, blocked: 112, bugs: 2, minutes: 41, testMode: true });
    expect(countedRuns([smoke, rehearsal])).toEqual([smoke]);
    expect(summarize(countedRuns([smoke, rehearsal]))).toMatchObject({ executions: 1, cases: 20, passRate: 100, bugs: 0, minutes: 6 });
  });
});
