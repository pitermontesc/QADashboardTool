import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { demoAppOptions, seedDemoData } from '../src/server/demo';
import { automationDetailsSchema, runInputSchema } from '../src/server/schemas';
import { Store } from '../src/server/store';
import type { AppState, Automation } from '../src/shared/types';

describe('Demo mode', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'qa-demo-')), 'data');
  let base = '';
  let close = (): Promise<void> => Promise.resolve();
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const state = async (): Promise<AppState> => (await call('GET', '/api/state')).body;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeAll(async () => {
    seedDemoData(dir, 'es');
    // 5 ms steps: the simulated run finishes right away.
    const server = createApp(new Store(path.join(dir, 'qa-tests.json')), demoAppOptions(dir, 5)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterAll(() => close());

  it('starts with valid sample data in both languages', async () => {
    const s = await state();
    expect(s.demo).toBe(true);
    expect(s.jira.connection).toBe('connected');
    expect(s.jira.tickets.map((t) => t.key)).toContain('AVM-7057');
    expect(s.runs.length).toBeGreaterThan(20);
    for (const run of s.runs) runInputSchema.parse(run);
    expect(s.automations.map((a) => `${a.kind} ${a.verdict}${a.dryRun ? ' (test mode)' : ''}`)).toEqual([
      'orchestrator PASSED W/F', 'smoke GO', 'regression NO-GO', 'regression NO-GO (test mode)', 'smoke BLOCKED',
    ]);
    // The rehearsal's record is listed, but marked so the dashboard leaves it out.
    const rehearsal = s.automations.find((a) => a.dryRun)!;
    expect(s.runs.filter((r) => r.testMode).map((r) => r.id)).toEqual([rehearsal.runId]);
    for (const a of s.automations) {
      if (a.details) automationDetailsSchema.parse(a.details);
      expect(a.translations.en?.summary).toBeTruthy();
    }
    expect(s.automations[0]!.details!.jiraComment).toMatchObject({ key: 'AVM-7057', posted: false });
  });

  it('simulates a smoke test: running, live activity and the report at the end', async () => {
    const { body: launched } = await call('POST', '/api/smoke', { site: 'stg' });
    expect(launched.finishedAt).toBeNull();
    let done: Automation | undefined;
    await until(async () => {
      done = (await state()).automations.find((a) => a.id === launched.id && a.finishedAt !== null);
      return done !== undefined;
    });
    expect(done).toMatchObject({ verdict: 'GO', lang: 'es' });
    expect(done!.details!.modules).toHaveLength(8);
    const { body: activity } = await call('GET', `/api/automation/${launched.id}/activity`);
    expect(activity.items.map((i: { kind: string }) => i.kind)).toContain('tool');
    expect(activity.items.at(-1)).toMatchObject({ kind: 'result' });
  });

  it('the simulated orchestrator leaves the comment and the demo "posts" it without leaving the machine', async () => {
    const { body: launched } = await call('POST', '/api/orchestrator/AVM-7061', {});
    await until(async () => (await state()).automations.some((a) => a.id === launched.id && a.finishedAt !== null));
    const { body } = await call('POST', `/api/automation/${launched.id}/jira-comment`, {});
    expect(body.details.jiraComment).toMatchObject({ key: 'AVM-7061', posted: true });
    expect(body.details.jiraComment.url).toMatch(/^https:\/\/example\.atlassian\.net\/browse\/AVM-7061\?focusedCommentId=\d+$/);
  });

  it('a full-coverage orchestrator run is simulated as an orchestrator run, though its prompt names the regression runner', async () => {
    const { body: launched } = await call('POST', '/api/orchestrator/AVM-7068', { fullCoverage: true });
    let done: Automation | undefined;
    await until(async () => {
      done = (await state()).automations.find((a) => a.id === launched.id && a.finishedAt !== null);
      return done !== undefined;
    });
    expect(done).toMatchObject({ kind: 'orchestrator', target: 'AVM-7068', fullCoverage: true, verdict: 'PASSED W/F' });
    expect(done!.summary).toMatch(/^AVM-7068 PASSED W\/F/);
  });

  it('switching to English leaves everything in English, including simulated runs', async () => {
    const settings = (await state()).settings;
    await call('PUT', '/api/settings', { ...settings, language: 'en' });
    await until(async () => (await state()).translating === 0);
    const s = await state();
    const smoke = s.automations.find((a) => a.kind === 'smoke' && a.lang === 'es' && a.target === 'STG' && a.finishedAt! > Date.now() - 60_000);
    expect(smoke?.translations.en?.summary).toMatch(/^Smoke on STG: GO/);
    expect(smoke?.translations.en?.details?.modules[0]?.name).toBe('Login and Dashboard');
    // No Spanish run titles or notes remain after the switch.
    expect(s.runs.filter((r) => /con Claude|Veredicto/.test(`${r.title} ${r.notes}`))).toEqual([]);
  });
});
