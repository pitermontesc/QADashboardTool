import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { lastMessage, readActivity } from '../src/server/claudeRunner';
import { demoAppOptions, seedDemoData } from '../src/server/demo';
import { markdownToJira } from '../src/server/jiraMarkup';
import { Store } from '../src/server/store';
import type { ReportTranslation } from '../src/shared/types';
import { fakeJira, startServer } from './helpers';

/**
 * Edge cases: unexpected API input, broken responses from external services and
 * races. Every expectation comes from the contract (guide, README, schemas or the
 * instruction Claude receives), not from what the code does today.
 */

const run = (over: Record<string, unknown> = {}) => ({
  date: '2026-11-18', typeId: 't2', title: 'Case', ticket: '', env: 'QA', result: 'passed',
  passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '', ...over,
});

describe('Test runs and settings: unexpected input', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => srv.close());

  it('rejects dates that do not exist in the calendar', async () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-11-31']) {
      expect((await srv.call('POST', '/api/runs', run({ date }))).status, date).toBe(400);
    }
    expect((await srv.call('POST', '/api/runs', run({ date: '2028-02-29' }))).status).toBe(201);
  });

  it('rejects negative or decimal counts, blank titles and types that do not exist', async () => {
    expect((await srv.call('POST', '/api/runs', run({ passed: -1 }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ failed: 1.5 }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ title: '   ' }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ typeId: 'missing' }))).status).toBe(400);
    const { body } = await srv.call('POST', '/api/runs', run());
    expect((await srv.call('PUT', `/api/runs/${body.id}`, run({ typeId: 'missing' }))).status).toBe(400);
  });

  it('does not allow removing a type with test runs or repeating type ids', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const used = state.runs[0].typeId;
    const withoutUsed = { ...state.settings, types: state.settings.types.filter((t: { id: string }) => t.id !== used) };
    expect((await srv.call('PUT', '/api/settings', withoutUsed)).status).toBe(409);
    const dup = { ...state.settings, types: [...state.settings.types, { ...state.settings.types[0] }] };
    expect((await srv.call('PUT', '/api/settings', dup)).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings.types).toHaveLength(state.settings.types.length);
  });

  it('does not import a backup with test runs of types that do not exist', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const backup = { ...state.settings, runs: [{ ...run({ typeId: 'ghost' }), id: 'r1', createdAt: 1 }] };
    expect((await srv.call('POST', '/api/import', backup)).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.runs).toHaveLength(state.runs.length);
  });

  it('rejects unknown languages or themes without touching the saved settings', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    expect((await srv.call('PUT', '/api/settings', { ...state.settings, theme: 'purple' })).status).toBe(400);
    expect((await srv.call('PUT', '/api/settings', { ...state.settings, language: 'fr' })).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings).toMatchObject({ theme: 'system', language: 'es' });
  });

  it('answers 404 for test runs or Claude runs that do not exist', async () => {
    expect((await srv.call('PUT', '/api/runs/nope', run())).status).toBe(404);
    expect((await srv.call('DELETE', '/api/runs/nope')).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/result', { verdict: 'GO' })).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/jira-comment', {})).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/translate', {})).status).toBe(404);
  });
});

describe('Result reported by Claude', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());
  // The same thing cannot be launched twice while running: each test stops what it left running.
  afterEach(async () => {
    for (const a of (await srv.call('GET', '/api/state')).body.automations) {
      if (a.finishedAt === null) await srv.call('POST', `/api/automation/${a.id}/stop`, {});
    }
  });

  it('only accepts the verdicts of that kind of run', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect((await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'PASSED' })).status).toBe(400);
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    expect((await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'GO' })).status).toBe(400);
    // They are still waiting for a valid result.
    expect((await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'no go' })).body.verdict).toBe('NO-GO');
    expect((await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'passed w/f' })).body.verdict).toBe('PASSED W/F');
  });

  it('does not launch the same thing twice while it runs (double click)', async () => {
    const [a, b] = await Promise.all([srv.call('POST', '/api/smoke', { site: 'stg' }), srv.call('POST', '/api/smoke', { site: 'stg' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const first = a.status === 200 ? a.body : b.body;
    // Another site or another ticket can be launched at the same time.
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-101', {})).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-101', {})).status).toBe(409);
    // Once finished, it can be launched again.
    await srv.call('POST', `/api/automation/${first.id}/result`, { verdict: 'GO' });
    expect((await srv.call('POST', '/api/smoke', { site: 'stg' })).status).toBe(200);
  });

  it('accepts long texts by clipping them, and numbers sent as text', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    const long = (n: number) => 'a'.repeat(n);
    const steps = Array.from({ length: 600 }, (_, i) => ({ name: `Step ${i + 1}`, status: 'passed' }));
    const { status, body } = await srv.call('POST', url, {
      verdict: 'GO', passed: '7', failed: ' 2 ', blocked: '', bugs: 0, minutes: '12.4', summary: long(6000),
      details: { notes: long(9000), modules: [{ name: long(300), status: 'passed', minutes: '3', steps: [{ name: long(800), status: 'passed', notes: long(3000) }, ...steps] }] },
    });
    expect(status).toBe(200);
    expect(body.summary).toHaveLength(5000);
    expect(body.summary.endsWith('…')).toBe(true);
    expect(body.details.notes).toHaveLength(5000);
    const [module] = body.details.modules;
    expect(module.name).toHaveLength(200);
    expect(module.minutes).toBe(3);
    expect(module.steps).toHaveLength(500);
    expect(module.steps[0].name).toHaveLength(500);
    expect(module.steps[0].notes).toHaveLength(2000);
    const run = (await srv.call('GET', '/api/state')).body.runs.find((r: { id: string }) => r.id === smoke.runId);
    expect(run).toMatchObject({ passed: 7, failed: 2, blocked: null, bugs: 0, minutes: 12 });
    // The test run notes combine verdict and summary: they are clipped too.
    expect(run.notes.length).toBeLessThanOrEqual(5000);
    expect(run.notes.startsWith('Veredicto GO.')).toBe(true);
  });

  it('still rejects non-numbers and negative numbers', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    for (const passed of ['seven', '-1', -1, '7.5', true]) {
      expect((await srv.call('POST', url, { verdict: 'GO', passed })).status, String(passed)).toBe(400);
    }
    expect((await srv.call('POST', url, { verdict: 'GO', minutes: 'a lot' })).status).toBe(400);
    expect((await srv.call('POST', url, { verdict: 'GO', passed: '8' })).status).toBe(200);
  });

  it('does not save non-http(s) links or accept the result twice', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    expect((await srv.call('POST', url, { verdict: 'GO', link: 'javascript:alert(1)' })).status).toBe(400);
    const bug = { title: 'x', link: 'javascript:alert(1)' };
    expect((await srv.call('POST', url, { verdict: 'GO', details: { bugs: [bug] } })).status).toBe(400);
    expect((await srv.call('POST', url, { verdict: 'GO' })).status).toBe(200);
    expect((await srv.call('POST', url, { verdict: 'NO-GO' })).status).toBe(409);
    const { body } = await srv.call('GET', '/api/state');
    expect(body.automations.find((a: { id: string }) => a.id === smoke.id).verdict).toBe('GO');
  });
});

describe('Jira comment: failures and double click', () => {
  let posts = 0;
  let mode: 'ok' | 'slow' | 'auth' | 'down' = 'ok';
  const jira: typeof fetch = async (input, init) => {
    if (init?.method !== 'POST') return fakeJira(input, init);
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'auth') return new Response('{}', { status: 401 });
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 50));
    posts++;
    return Response.json({ id: String(posts) }, { status: 201 });
  };
  let srv: Awaited<ReturnType<typeof startServer>>;
  const draft = async () => {
    const { body: a } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'PASSED', details: { jiraComment: { key: 'AVM-101', body: 'QA OK' } } });
    return `/api/automation/${a.id}/jira-comment`;
  };
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());

  it('if Jira fails, the comment stays pending and can be retried', async () => {
    const url = await draft();
    mode = 'auth';
    expect((await srv.call('POST', url, {})).status).toBe(502);
    mode = 'down';
    expect((await srv.call('POST', url, {})).status).toBe(502);
    mode = 'ok';
    const { status, body } = await srv.call('POST', url, {});
    expect(status).toBe(200);
    expect(body.details.jiraComment.posted).toBe(true);
    expect(posts).toBe(1);
  });

  it('two simultaneous clicks post only once', async () => {
    const url = await draft();
    mode = 'slow';
    const before = posts;
    const results = await Promise.all([srv.call('POST', url, {}), srv.call('POST', url, {})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(posts - before).toBe(1);
    mode = 'ok';
  });

  it('without Jira configured, posts nothing and leaves it pending', async () => {
    const url = await draft();
    await srv.call('PUT', '/api/jira/config', { site: '', email: '', board: '', jql: '', token: '' });
    const before = posts;
    expect((await srv.call('POST', url, {})).status).toBe(400);
    expect(posts).toBe(before);
    const id = url.split('/')[3];
    const { body } = await srv.call('GET', '/api/state');
    expect(body.automations.find((a: { id: string }) => a.id === id).details.jiraComment.posted).toBe(false);
  });
});

describe('Translation with broken responses', () => {
  let answer: () => unknown = () => ({});
  let calls = 0;
  let srv: Awaited<ReturnType<typeof startServer>>;
  const original = {
    notes: 'Notes', modules: [{ name: 'Login', status: 'failed', steps: [{ name: 'Sign in', status: 'failed', notes: 'Error 500' }] }],
    bugs: [{ title: 'Login returns 500', severity: 'High', key: 'AVM-1' }],
  };
  beforeAll(async () => {
    srv = await startServer({
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      translateReport: async (_report: ReportTranslation) => {
        calls++;
        return answer();
      },
    });
  });
  afterAll(() => srv.close());
  const finished = async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'NO-GO', summary: 'Login fails', details: original });
    return a.id as string;
  };

  it('a response that is not a report keeps the original and is not retried automatically', async () => {
    const id = await finished();
    answer = () => 'not JSON';
    expect((await srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' })).status).toBe(502);
    const before = calls;
    const settings = (await srv.call('GET', '/api/state')).body.settings;
    await srv.call('PUT', '/api/settings', { ...settings, language: 'en' });
    await srv.call('PUT', '/api/settings', { ...settings, language: 'es' });
    // Changing the language does not retry the failed one.
    expect(calls).toBe(before);
    const a = (await srv.call('GET', '/api/state')).body.automations.find((x: { id: string }) => x.id === id);
    expect(a.translations).toEqual({});
    expect(a.summary).toBe('Login fails');
  });

  it('a translation that changes statuses, keys or links does not change them in the report', async () => {
    const id = await finished();
    answer = () => ({
      summary: 'Login fails',
      details: {
        notes: 'Notes', build: '',
        modules: [{ name: 'Sign in', status: 'passed', minutes: 99, steps: [{ name: 'Enter', status: 'passed', notes: 'HTTP 500' }, { name: 'Extra', status: 'passed' }] }, { name: 'Ghost', status: 'passed' }],
        bugs: [{ title: 'Login returns 500', severity: 'Low', key: 'AVM-999', link: 'https://evil.example' }],
      },
    });
    const { body } = await srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' });
    expect(body.translations.en.details.modules).toEqual([
      { name: 'Sign in', status: 'failed', minutes: null, notes: '', steps: [{ name: 'Enter', status: 'failed', notes: 'HTTP 500' }] },
    ]);
    expect(body.translations.en.details.bugs).toEqual([{ title: 'Login returns 500', severity: 'High', key: 'AVM-1', link: '', module: '' }]);
  });

  it('deleting the run while it is being translated breaks nothing', async () => {
    const id = await finished();
    let release: (v: unknown) => void = () => undefined;
    answer = () => new Promise((r) => (release = r));
    const before = calls;
    const pending = srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' });
    // Wait until the translation is in progress (the translator already received the report).
    while (calls === before) await new Promise((r) => setTimeout(r, 1));
    expect((await srv.call('DELETE', `/api/automation/${id}`)).status).toBe(204);
    release({ summary: 'Login fails', details: null });
    expect((await pending).status).toBe(200);
    expect((await srv.call('GET', '/api/state')).body.automations.some((a: { id: string }) => a.id === id)).toBe(false);
  });
});

describe('Claude log: missing or corrupted files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-log-'));

  it('a log that does not exist gives no activity or message', () => {
    expect(readActivity(path.join(dir, 'missing.jsonl'))).toEqual([]);
    expect(lastMessage(path.join(dir, 'missing.jsonl'))).toBe('');
  });

  it('corrupted lines show up as errors and do not hide the rest', () => {
    const file = path.join(dir, 'broken.jsonl');
    writeFileSync(file, ['{"type":"system","subtype":"init"}', '{broken', '', '{"type":"assistant","message":{"content":"plain text"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]}}'].join('\n'));
    expect(readActivity(file)).toEqual([{ kind: 'start', text: '' }, { kind: 'error', text: '{broken' }, { kind: 'text', text: 'Done' }]);
    expect(lastMessage(file)).toBe('Done');
  });

  it('in a huge log, reads only the end and does not show the cut first line', () => {
    const file = path.join(dir, 'large.jsonl');
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
    writeFileSync(file, `${Array.from({ length: 700 }, () => filler).join('\n')}\n${JSON.stringify({ type: 'result', result: 'End' })}\n`);
    const items = readActivity(file, 1000);
    expect(items.every((i) => i.kind !== 'error')).toBe(true);
    expect(items.at(-1)).toEqual({ kind: 'result', text: 'End' });
  });
});

describe('Demo: edge cases', () => {
  it('stopping a simulated run leaves it BLOCKED and the simulation does not report afterwards', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'qa-demo-')), 'data');
    seedDemoData(dir, 'es');
    const server = createApp(new Store(path.join(dir, 'qa-tests.json')), demoAppOptions(dir, 5)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) =>
      (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
    try {
      const launched = await call('POST', '/api/smoke', { site: 'qa' });
      await call('POST', `/api/automation/${launched.id}/stop`);
      await new Promise((r) => setTimeout(r, 150));
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.automations.find((a: { id: string }) => a.id === launched.id)).toMatchObject({ verdict: 'BLOCKED' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sample data never has future dates, even when opened just after midnight', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'qa-demo-')), 'data');
    const now = new Date(2026, 10, 19, 0, 40).getTime();
    seedDemoData(dir, 'es', now);
    const state = new Store(path.join(dir, 'qa-tests.json')).getState();
    for (const r of state.runs) expect(r.createdAt, r.title).toBeLessThanOrEqual(now);
    for (const a of state.automations) expect(a.finishedAt!, a.title).toBeLessThanOrEqual(now);
  });
});

describe('markdownToJira: unusual input', () => {
  it('accepts Windows line endings', () => {
    expect(markdownToJira('### Hello\r\n- one\r\n')).toBe('h3. Hello\n* one\n');
  });

  it('an unclosed code block keeps its text', () => {
    expect(markdownToJira('Before\n```\nline 1\nline 2')).toBe('Before\n{code}\nline 1\nline 2\n{code}');
  });

  it('Markdown italics become Jira italics', () => {
    expect(markdownToJira('See *note* and **bold**')).toBe('See _note_ and *bold*');
  });

  it('a stray asterisk does not become bold in Jira', () => {
    // In wiki markup *a* is bold: Markdown "2*3*4" must still read the same.
    expect(markdownToJira('Total 2*3*4 = 24')).toBe('Total 2\\*3\\*4 = 24');
  });
});
