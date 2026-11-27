import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { buildTeamFile, teamFileName, writeTeamFile } from '../src/server/team';
import type { Automation, TestRun } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.22.0): in a folder the team syncs, each app writes only its own file (its runs and
 * reports, never the Jira connection or the settings) and reads everyone else's. A teammate's file
 * comes from another Mac: it is checked like an import, and a bad one is reported, never fatal.
 */

const run = (id: string, title: string, extra: Partial<TestRun> = {}): TestRun => ({
  id, createdAt: 1, date: '2026-11-20', typeId: 't-functional', title, ticket: 'AVM-1', env: 'QA', result: 'passed',
  passed: 3, failed: 0, blocked: 0, bugs: 0, minutes: 20, notes: '', testMode: false, ...extra,
});
const report = (id: string, extra: Partial<Automation> = {}): Automation => ({
  id, kind: 'orchestrator', target: 'AVM-1', title: 'QA orchestrator · AVM-1', env: 'QA', startedAt: 1, finishedAt: 2, verdict: 'PASSED',
  summary: 'ok', link: '', runId: null, pid: 4242, logFile: '/Users/ana/qa-dashboard-runs/logs/x.jsonl', lang: 'es', translations: {},
  dryRun: false, fullCoverage: false, site: 'qa', ticketType: 'Story', queued: { batch: 'b', retries: 0 },
  details: {
    build: '', modules: [], notes: '', bugs: [{ title: 'Bug', severity: 'Major', key: 'AVM-9', link: 'https://example.atlassian.net/browse/AVM-9', module: '' }],
    jiraComment: { key: 'AVM-1', body: 'draft', posted: false, url: '', dismissed: false },
  },
  ...extra,
});
const TYPES = [{ id: 't-functional', name: 'Funcional', major: false, color: '#3b82c4' }];
const teammate = (id: string, name: string, runs: TestRun[], automations: Automation[] = [], updatedAt = Date.now()) =>
  buildTeamFile({ id, name }, '1.22.0', TYPES, runs, automations, updatedAt);

describe('Team folder in the app', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-team-'));
  const folder = path.join(root, 'QA Team');
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'secret-email@example.com', jql: '', token: 'secret-token-123' });
  });
  beforeEach(async () => {
    await srv.call('DELETE', '/api/team');
    rmSync(folder, { recursive: true, force: true });
  });
  afterAll(() => srv.close());

  const team = async () => (await srv.call('GET', '/api/team')).body;
  const files = () => readdirSync(folder).filter((f) => f.endsWith('.qa-team.json')).sort();

  it('not in a team: nothing is written, and the view is empty', async () => {
    expect(await team()).toMatchObject({ folder: '', members: [], problems: [], error: null });
    expect(existsSync(folder)).toBe(false);
  });

  it('joining creates the folder and writes this app\'s own file, without the Jira connection or the machine\'s details', async () => {
    await srv.call('POST', '/api/runs', { date: '2026-11-21', typeId: 't0', title: 'Login works', result: 'passed', passed: 2 });
    const { status, body } = await srv.call('PUT', '/api/team', { folder, name: 'Piter Montes' });
    expect(status).toBe(200);
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ name: 'Piter Montes', me: true });
    const [mine] = files();
    expect(mine).toMatch(/^piter-montes--[\w-]{8}\.qa-team\.json$/);
    expect(body.ownFile).toBe(mine);
    const text = readFileSync(path.join(folder, mine!), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ format: 'qa-dashboard-team', version: 1, member: { name: 'Piter Montes' }, runs: [{ title: 'Login works' }] });
    for (const secret of ['secret-token-123', 'secret-email@example.com', 'example.atlassian.net"', 'jql']) expect(text).not.toContain(secret);
    expect((await srv.call('GET', '/api/state')).body.team).toMatchObject({ ownFile: mine, error: null });
  });

  it('reads the teammates\' files: their runs and reports, without what belongs to their Mac', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    writeTeamFile(folder, teammate('ana-0000-1111', 'Ana Ríos', [run('a1', 'Ana tests AVM-1')], [report('r1')]));
    const { members } = await team();
    expect(members.map((m: { name: string; me: boolean }) => [m.name, m.me])).toEqual([['Piter', true], ['Ana Ríos', false]]);
    const ana = members[1];
    expect(ana.runs.map((r: TestRun) => r.title)).toEqual(['Ana tests AVM-1']);
    expect(ana.automations[0]).toMatchObject({ verdict: 'PASSED', pid: null, logFile: '', queued: null, details: { jiraComment: null, bugs: [{ key: 'AVM-9' }] } });
  });

  it('a bad file is reported and skipped; the others still load', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    writeTeamFile(folder, teammate('ana-0000-1111', 'Ana', [run('a1', 'ok')]));
    writeFileSync(path.join(folder, 'half--12345678.qa-team.json'), '{"format":"qa-dash');
    writeFileSync(path.join(folder, 'other--87654321.qa-team.json'), JSON.stringify({ hello: 'world' }));
    // A link that is not http(s) in a teammate's report: the file is refused, not shown.
    writeTeamFile(folder, teammate('evil-0000-2222', 'Evil', [], [report('r2', { link: 'javascript:alert(1)' })]));
    writeFileSync(path.join(folder, 'notes.txt'), 'not a team file');
    const { members, problems } = await team();
    expect(members.map((m: { name: string }) => m.name)).toEqual(['Piter', 'Ana']);
    expect(problems.map((p: { file: string }) => p.file).sort()).toEqual(['evil--evil-000.qa-team.json', 'half--12345678.qa-team.json', 'other--87654321.qa-team.json']);
    expect(problems.find((p: { file: string }) => p.file.startsWith('half'))!.error).toBe('No es JSON válido (puede que todavía se esté sincronizando)');
    expect(problems.find((p: { file: string }) => p.file.startsWith('other'))!.error).toMatch(/^No es un archivo de equipo de QA Dashboard/);
  });

  it('two files from the same app: the newest wins; a file claiming this app\'s id is not shown as a teammate', async () => {
    const { body } = await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    const myId = JSON.parse(readFileSync(path.join(folder, body.ownFile), 'utf8')).member.id;
    // The older file is read first: it must not win.
    writeFileSync(path.join(folder, 'a-ana-old--ana-0000.qa-team.json'), JSON.stringify(teammate('ana-0000-1111', 'Ana (old)', [], [], 1000)));
    writeFileSync(path.join(folder, 'b-ana-new--ana-0000.qa-team.json'), JSON.stringify(teammate('ana-0000-1111', 'Ana', [], [], 2000)));
    writeFileSync(path.join(folder, 'copy--whatever.qa-team.json'), JSON.stringify(teammate(myId, 'Piter (copy)', [])));
    expect((await team()).members.map((m: { name: string }) => m.name)).toEqual(['Piter', 'Ana']);
  });

  it('writes again when the data or the name changes, under the new name, and only removes its own old file', async () => {
    const { body: joined } = await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    writeTeamFile(folder, teammate('ana-0000-1111', 'Ana', []));
    // Someone else's file that happens to end like this app's: never removed.
    const lookalike = joined.ownFile.replace(/^piter/, 'someone');
    writeFileSync(path.join(folder, lookalike), JSON.stringify(teammate('someone-else-9999', 'Someone', [])));
    await srv.call('POST', '/api/runs', { date: '2026-11-22', typeId: 't0', title: 'A new run', result: 'failed', failed: 1 });
    const { ownFile } = await team();
    expect(JSON.parse(readFileSync(path.join(folder, ownFile), 'utf8')).runs.map((r: TestRun) => r.title)).toContain('A new run');
    const { body } = await srv.call('PUT', '/api/team', { folder, name: 'Piter M.' });
    expect(body.ownFile).toMatch(/^piter-m--/);
    expect(files()).toEqual([body.ownFile, lookalike, teamFileName({ id: 'ana-0000-1111', name: 'Ana' })].sort());
  });

  it('leaving takes only this app\'s file out of the folder', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    writeTeamFile(folder, teammate('ana-0000-1111', 'Ana', []));
    const { body } = await srv.call('DELETE', '/api/team');
    expect(body).toMatchObject({ folder: '', members: [] });
    expect(files()).toEqual([teamFileName({ id: 'ana-0000-1111', name: 'Ana' })]);
  });

  it('refuses a folder that is not a full path or whose parent is missing, and a missing name', async () => {
    const relative = await srv.call('PUT', '/api/team', { folder: 'QA Team', name: 'Piter' });
    expect([relative.status, relative.body.error]).toEqual([400, 'La carpeta del equipo tiene que ser una ruta completa (puede empezar con ~/)']);
    const orphan = await srv.call('PUT', '/api/team', { folder: path.join(root, 'nope', 'QA'), name: 'Piter' });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error).toMatch(/^La carpeta .* no existe$/);
    expect((await srv.call('PUT', '/api/team', { folder, name: ' ' })).status).toBe(400);
    expect((await team()).folder).toBe('');
  });

  it('a folder that disappears (the sync app closed) is an error to show, not a crash', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    rmSync(folder, { recursive: true, force: true });
    const view = await team();
    expect(view.error).toMatch(/^La carpeta del equipo .* no está \(¿está abierta la app que la sincroniza\?\)$/);
    expect((await srv.call('GET', '/api/state')).status).toBe(200);
  });
});

describe('What a team file holds', () => {
  it('no process, log path, queue or Jira comment draft: they belong to the Mac that ran the report', () => {
    const file = buildTeamFile({ id: 'piter-0000-0001', name: 'Piter' }, '1.22.0', TYPES, [run('p1', 'x')], [report('r1')]);
    expect(file.automations[0]).toMatchObject({ pid: null, logFile: '', queued: null, details: { jiraComment: null, bugs: [{ key: 'AVM-9' }] } });
    expect(JSON.stringify(file)).not.toContain('/Users/');
  });
});

describe('Team identity', () => {
  it('is made once per app, kept across restarts, and not brought by an imported backup', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-team-id-')), 'qa-tests.json');
    const store = new Store(file);
    store.saveTeamConfig({ folder: '/tmp/x', name: 'Piter' });
    const id = store.getTeamConfig().memberId;
    expect(id).toMatch(/^[\w-]{36}$/);
    expect(new Store(file).getTeamConfig()).toEqual({ folder: '/tmp/x', name: 'Piter', memberId: id });
    const again = new Store(file);
    again.importBackup({ ...again.getState().settings, runs: [] });
    expect(again.getTeamConfig().memberId).toBe(id);
  });
});
