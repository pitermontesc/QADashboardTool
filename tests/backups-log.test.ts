import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppLog } from '../src/server/log';
import { Store } from '../src/server/store';
import { startServer } from './helpers';

/**
 * Contract (v1.16.0, README "Data and security"):
 * - The first change of each day copies the data file, as it was before that change, to `backups/`;
 *   the last 14 daily copies are kept. Copies are 0600 (they hold the Jira token).
 * - An import or a restore keeps a copy of the current data first; both are refused (409) while a
 *   run is in progress or queued. A restore brings back runs, reports and settings and keeps the
 *   Jira connection.
 * - `logs/app.log` records launches and results; the Jira token, report keys and authorization
 *   headers never reach it. It rotates at 1 MB, keeping the previous file as `app.log.1`.
 */
const RUN = { date: '2026-11-17', typeId: 't0', title: 'Smoke release', result: 'passed', passed: 20, failed: 0 };
const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'qa-bk-')), 'qa-tests.json');
const backupsOf = (file: string) => {
  const dir = path.join(path.dirname(file), 'backups');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const runTitles = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { runs: { title: string }[] }).runs.map((r) => r.title);

describe('Automatic backups (Store)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the first change of a day keeps the data as it was before it, once a day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 24, 9, 0));
    const file = tempFile();
    const store = new Store(file);
    store.createRun({ ...RUN, title: 'First' } as never);
    // No data file existed before the first change: nothing to copy yet.
    expect(backupsOf(file)).toEqual([]);

    vi.setSystemTime(new Date(2026, 10, 25, 8, 30));
    // Even if the data file was opened up by hand, its copy is private.
    chmodSync(file, 0o644);
    store.createRun({ ...RUN, title: 'Second' } as never);
    store.createRun({ ...RUN, title: 'Third' } as never);
    expect(backupsOf(file)).toEqual(['qa-tests-2026-11-25.json']);
    const copy = path.join(path.dirname(file), 'backups', 'qa-tests-2026-11-25.json');
    // The copy is the data from before the day's first change.
    expect(runTitles(copy)).toEqual(['First']);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(runTitles(file).sort()).toEqual(['First', 'Second', 'Third']);
  });

  it('keeps the last 14 daily copies', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const file = tempFile();
    const store = new Store(file);
    for (let day = 1; day <= 20; day++) {
      vi.setSystemTime(new Date(2026, 10, day, 12, 0));
      store.createRun({ ...RUN, title: `Day ${day}` } as never);
    }
    const daily = backupsOf(file);
    expect(daily).toHaveLength(14);
    expect(daily[0]).toBe('qa-tests-2026-11-07.json');
    expect(daily.at(-1)).toBe('qa-tests-2026-11-20.json');
  });

  it('a copy that cannot be made does not stop the change being saved', () => {
    const file = tempFile();
    const store = new Store(file);
    store.createRun({ ...RUN, title: 'First' } as never);
    // A file where the backups folder should be: the copy fails.
    writeFileSync(path.join(path.dirname(file), 'backups'), 'not a folder');
    store.createRun({ ...RUN, title: 'Second' } as never);
    expect(runTitles(file).sort()).toEqual(['First', 'Second']);
    expect(readFileSync(store.log.file, 'utf8')).toMatch(/ERROR backup\.failed/);
  });
});

describe('Import, restore and the app log (API)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const logText = () => readFileSync(path.join(path.dirname(srv.file), 'logs', 'app.log'), 'utf8');
  beforeAll(async () => {
    srv = await startServer({ launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
  });
  afterEach(() => srv.reset());
  afterAll(() => srv.close());

  it('an import keeps a copy of the data it replaces', async () => {
    await srv.call('POST', '/api/runs', { ...RUN, title: 'Before import' });
    const { body: state } = await srv.call('GET', '/api/state');
    expect((await srv.call('POST', '/api/import', { ...state.settings, runs: [] })).status).toBe(200);

    const { body } = await srv.call('GET', '/api/backups');
    const copy = body.items.find((b: { reason: string }) => b.reason === 'before-import');
    expect(copy).toMatchObject({ runs: 1, name: expect.stringMatching(/^qa-tests-\d{4}-\d{2}-\d{2}-\d{6}-before-import\.json$/) });
    expect(runTitles(path.join(body.dir, copy.name))).toEqual(['Before import']);
  });

  it('restores runs, reports and settings from a copy, keeps the Jira connection, and can be undone', async () => {
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'secret-token-123' });
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('POST', '/api/import', { ...state.settings, envs: ['QA'], runs: [{ ...RUN, id: 'r1', createdAt: 1, title: 'Keep me' }] });
    const { body: made } = await srv.call('POST', '/api/backups', {});
    expect(made.created).toMatch(/-manual\.json$/);

    // Later the data changes, and the copy is restored.
    await srv.call('POST', '/api/import', { ...state.settings, envs: ['STG'], runs: [] });
    const restored = await srv.call('POST', `/api/backups/${made.created}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.runs.map((r: { title: string }) => r.title)).toEqual(['Keep me']);
    expect(restored.body.settings.envs).toEqual(['QA']);
    expect(restored.body.jira).toMatchObject({ site: 'https://example.atlassian.net', hasToken: true });

    // The data it replaced was kept: restoring that copy undoes the restore.
    const { body } = await srv.call('GET', '/api/backups');
    const undo = body.items.find((b: { reason: string }) => b.reason === 'before-restore');
    expect(undo).toMatchObject({ runs: 0 });
    expect((await srv.call('POST', `/api/backups/${undo.name}/restore`, {})).body.settings.envs).toEqual(['STG']);
  });

  it('refuses to replace the data while a run is in progress, and changes nothing', async () => {
    const { body: made } = await srv.call('POST', '/api/backups', {});
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    const before = (await srv.call('GET', '/api/state')).body.runs.length;

    const restore = await srv.call('POST', `/api/backups/${made.created}/restore`, {});
    expect(restore).toMatchObject({ status: 409, body: { error: expect.stringContaining('en curso') } });
    expect((await srv.call('POST', '/api/import', { ...state.settings, runs: [] })).status).toBe(409);
    expect((await srv.call('GET', '/api/state')).body.runs).toHaveLength(before);
  });

  it('only restores a copy from the backups folder', async () => {
    for (const name of ['..%2Fqa-tests.json', 'qa-tests.json', 'qa-tests-2026-01-01.json', 'evil.json']) {
      expect((await srv.call('POST', `/api/backups/${name}/restore`, {})).status).toBe(404);
    }
  });

  it('logs launches and results, never the Jira token or a report key', async () => {
    const { body: run } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${run.id}/result`, { verdict: 'NO-GO', summary: 'Login page down\nmore detail' });
    const text = logText();
    expect(text).toMatch(new RegExp(`INFO  claude\\.start id=${run.id} kind=smoke target=QA site=qa`));
    expect(text).toMatch(new RegExp(`WARN  claude\\.finish id=${run.id} kind=smoke target=QA site=qa verdict=NO-GO minutes=0 summary="Login page down"`));
    expect(text).toMatch(/INFO  data\.restore from=qa-tests-.*-manual\.json/);
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain(srv.reportKey(run.id));

    // A deleted record can be traced (and found in a copy).
    const { body: created } = await srv.call('POST', '/api/runs', { ...RUN, title: 'Gone soon' });
    await srv.call('DELETE', `/api/runs/${created.id}`);
    expect(logText()).toMatch(new RegExp(`INFO  record\\.delete id=${created.id} date=2026-11-17 title="Gone soon"`));

    const { body } = await srv.call('GET', '/api/log');
    expect(body.lines.at(-1)).toContain('record.delete');
  });
});

describe('App log file', () => {
  const file = () => path.join(path.dirname(tempFile()), 'logs', 'app.log');

  it('hides the Jira token, report keys and authorization headers wherever they appear', () => {
    const log = new AppLog(file());
    log.hide('tok_ABCDEF123456');
    log.error('request.error', new Error('POST /api/automation/a1/result/0123456789abcdef0123 failed with tok_ABCDEF123456'), { auth: 'Basic cWFAZXhhbXBsZS5jb206dG9r' });
    const [line] = log.tail();
    expect(line).toContain('/result/<key>');
    expect(line).toContain('<hidden>');
    expect(line).toContain('Basic <hidden>');
    expect(line).not.toMatch(/tok_ABCDEF123456|0123456789abcdef0123|cWFAZXhhbXBsZS5jb206dG9r/);
  });

  it('rotates past 1 MB and still shows the last lines across both files', () => {
    const log = new AppLog(file());
    const big = 'x'.repeat(400);
    // ~455 bytes a line: the file passes 1 MB around line 2300, so ~100 lines end up in the new file.
    for (let i = 0; i < 2400; i++) log.info('filler', { i, big });
    log.info('last-line');
    expect(statSync(`${log.file}.1`).size).toBeGreaterThan(1024 * 1024);
    expect(readFileSync(log.file, 'utf8').split('\n').length).toBeLessThan(300);
    const tail = log.tail(300);
    expect(tail).toHaveLength(300);
    // Lines from the previous file come first, in order.
    expect(tail[0]).toMatch(/filler i=2101 /);
    expect(tail.at(-1)).toContain('last-line');
    expect(tail.every((l) => /^\d{4}-\d{2}-\d{2} /.test(l))).toBe(true);
  });

  it('a log that cannot be written does not throw', () => {
    const dir = path.dirname(tempFile());
    writeFileSync(path.join(dir, 'logs'), 'not a folder');
    expect(() => new AppLog(path.join(dir, 'logs', 'app.log')).info('x')).not.toThrow();
  });
});
