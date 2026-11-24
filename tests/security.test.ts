import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeJob } from '../src/server/claudeRunner';
import { csvCell } from '../src/client/exporters';
import { fakeJira, startServer } from './helpers';

/**
 * Contract (v1.14.0): the local API only takes changes from the app's own page, results only from
 * the Claude process each run launched, keeps every QA report, never sends the Jira token to another
 * site, and closes runs that an earlier session left "in progress".
 */
describe('Local API protection', () => {
  const launched: ClaudeJob[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: fakeJira,
      launchClaude: async (job) => {
        launched.push(job);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
  });
  afterAll(() => srv.close());

  const raw = (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
    fetch(srv.base + path, { method, headers: init.headers, body: init.body });

  it('a page on another local port cannot launch Claude, with or without a JSON body', async () => {
    // A "simple" no-cors request: text/plain body, no preflight.
    const plain = await raw('POST', '/api/regression', { headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(plain.status).toBe(415);
    const otherPort = await raw('POST', '/api/regression', {
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: '{}',
    });
    expect(otherPort.status).toBe(403);
    // A DELETE without the JSON content type is refused too.
    expect((await raw('DELETE', '/api/runs/nope')).status).toBe(415);
    expect(launched).toHaveLength(0);
  });

  it('pages cannot be framed and only load their own resources', async () => {
    const res = await raw('GET', '/api/state');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('a result is only accepted with the key the run gave Claude, and the key never reaches the UI', async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    const key = srv.reportKey(a.id);
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    // In the path, with no "?" that zsh would glob in Claude's curl.
    expect(launched.at(-1)!.prompt).toContain(`/api/automation/${a.id}/result/${key} `);
    expect(JSON.stringify((await srv.call('GET', '/api/state')).body)).not.toContain(key);
    expect(readFileSync(srv.file, 'utf8')).not.toContain(key);

    const forged = JSON.stringify({ verdict: 'GO', summary: 'All good', details: { jiraComment: { key: 'AVM-1', body: 'Ship it' } } });
    const json = { 'Content-Type': 'application/json' };
    expect((await raw('POST', `/api/automation/${a.id}/result`, { headers: json, body: forged })).status).toBe(403);
    expect((await raw('POST', `/api/automation/${a.id}/result/${'0'.repeat(48)}`, { headers: json, body: forged })).status).toBe(403);
    expect((await srv.call('GET', '/api/state')).body.automations.find((x: { id: string }) => x.id === a.id).finishedAt).toBeNull();

    expect((await srv.call('POST', `/api/automation/${a.id}/result/${key}`, { verdict: 'NO-GO', summary: 'Login fails' })).status).toBe(200);
  });

  it('keeps every QA report (there used to be a limit of 30)', async () => {
    for (let i = 0; i < 32; i++) {
      const { body: a } = await srv.call('POST', '/api/smoke', { site: i % 2 ? 'qa' : 'stg' });
      await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'GO', summary: `Smoke ${i}` });
    }
    expect((await srv.call('GET', '/api/state')).body.automations.length).toBeGreaterThanOrEqual(33);
  });

  it('a backup includes the QA reports and importing it brings them back, without process or log', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const report = { ...state.automations[0], pid: 4242, logFile: '/etc/passwd' };
    const backup = { ...state.settings, runs: state.runs, automations: [report] };
    const { status, body } = await srv.call('POST', '/api/import', backup);
    expect(status).toBe(200);
    expect(body.automations).toHaveLength(1);
    expect(body.automations[0]).toMatchObject({ id: report.id, summary: report.summary, pid: null, logFile: '' });
    // A backup from before v1.14.0 (no reports) keeps the current ones.
    await srv.call('POST', '/api/import', { ...state.settings, runs: state.runs });
    expect((await srv.call('GET', '/api/state')).body.automations).toHaveLength(1);
    // Two runs with the same id are refused.
    expect((await srv.call('POST', '/api/import', { ...state.settings, runs: [state.runs[0], state.runs[0]] })).status).toBe(400);
  });

  it('the saved Jira token is never sent to a different site, and the site must be https', async () => {
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    expect((await srv.call('PUT', '/api/jira/config', { site: 'http://example.atlassian.net', email: 'qa@example.com', jql: '' })).status).toBe(400);
    // Same site without a token: the token is kept.
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net/', email: 'qa@example.com', jql: 'project = AVM' });
    expect((await srv.call('GET', '/api/state')).body.jira.hasToken).toBe(true);
    // Another site without a token: the old token is dropped, so a refresh has nothing to send there.
    const { body } = await srv.call('PUT', '/api/jira/config', { site: 'https://other.example.net', email: 'qa@example.com', jql: '' });
    expect(body.hasToken).toBe(false);
    expect((await srv.call('POST', '/api/jira/refresh', {})).status).toBe(400);
  });
});

describe('Runs left "in progress" by an earlier session', () => {
  /** A data file with a run in progress, as left by an app that was closed while Claude ran. */
  const leftover = async (pid: number | null, alive: boolean, startedAt = Date.now()) => {
    const first = await startServer({ launchClaude: async () => ({ pid, logFile: '', stop: () => undefined }) });
    const { body: a } = await first.call('POST', '/api/smoke', { site: 'stg' });
    await first.close();
    const data = JSON.parse(readFileSync(first.file, 'utf8'));
    data.automations[0].startedAt = startedAt;
    writeFileSync(first.file, JSON.stringify(data));
    const { Store } = await import('../src/server/store');
    const { createApp } = await import('../src/server/app');
    const checked: number[] = [];
    const app = createApp(new Store(first.file), {
      processAlive: (p) => {
        checked.push(p);
        return alive;
      },
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const state = await (await fetch(`${base}/api/state`)).json();
    server.close();
    return { automation: state.automations.find((x: { id: string }) => x.id === a.id), checked };
  };

  it('a run whose Claude process is gone is closed as BLOCKED at startup, saying why', async () => {
    const { automation } = await leftover(999_999, false);
    expect(automation.verdict).toBe('BLOCKED');
    expect(automation.summary).toMatch(/sin reportar el resultado/);
  });

  it('a run whose Claude process is still alive stays in progress', async () => {
    const { automation, checked } = await leftover(999_999, true);
    expect(automation.finishedAt).toBeNull();
    expect(checked).toContain(999_999);
  });

  it('a run past the time limit is stopped and closed', async () => {
    const { automation } = await leftover(999_999, true, Date.now() - 5 * 60 * 60_000);
    expect(automation.verdict).toBe('BLOCKED');
    expect(automation.summary).toMatch(/tiempo máximo/);
  });
});

describe('Report translations', () => {
  it('a translator that fails at once (no claude) does not leave translations pending forever', async () => {
    const srv = await startServer({
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      translateReport: () => {
        throw new Error('Claude Code (claude) was not found on this Mac');
      },
    });
    for (const site of ['qa', 'stg']) {
      const { body: a } = await srv.call('POST', '/api/smoke', { site });
      await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'GO', summary: 'Todo bien' });
    }
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('PUT', '/api/settings', { ...state.settings, language: 'en' });
    await expect.poll(async () => (await srv.call('GET', '/api/state')).body.translating).toBe(0);
    await srv.close();
  });
});

describe('CSV export', () => {
  it('text a spreadsheet would run as a formula is exported as text', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('Smoke release 2.14')).toBe('"Smoke release 2.14"');
    expect(csvCell(-3)).toBe('"-3"');
  });
});
