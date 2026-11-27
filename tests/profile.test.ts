import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { demoAppOptions, demoDataDir } from '../src/server/demo';
import { readQaProfile, writeQaProfile } from '../src/server/profile';
import { profileFacts, readyFacts } from '../src/server/setup';
import { startServer } from './helpers';

/**
 * Contract (v1.20.0): the app reads and saves the QA profile the AVM skills read
 * (`~/.config/avm-qa/profile.json`): the tester and the TC executor, each with their Jira name and
 * accountId. The tester comes from the Jira connection (`/myself`); the TC executor is searched in
 * Jira by name. Other keys in the file are kept. The demo and the tests use their own file.
 */

const ANA = { name: 'Ana Ríos', accountId: '712020:aaaa-1111' };
const LUIS = { name: 'Luis Torres', accountId: '712020:bbbb-2222' };

describe('QA profile file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-profile-'));
  const file = path.join(dir, 'nested', 'profile.json');

  it('a missing file is an empty profile', () => {
    expect(readQaProfile(file)).toMatchObject({ exists: false, unreadable: false, tester: null, tcExecutor: null });
  });

  it('saves the tester and the executor, creating the folder, and keeps the keys the app does not know', () => {
    writeQaProfile({ tester: ANA, tcExecutor: LUIS }, file);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw).toEqual({ tester: ANA, tcExecutor: LUIS });
    writeFileSync(file, JSON.stringify({ ...raw, team: 'AVM', tester: { ...ANA, extra: 1 } }));
    const saved = writeQaProfile({ tester: { name: 'Ana R.', accountId: ANA.accountId }, tcExecutor: null }, file);
    // No executor: its key goes (the skills then leave the [TC] items with the tester).
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ team: 'AVM', tester: { name: 'Ana R.', accountId: ANA.accountId } });
    expect(saved).toMatchObject({ exists: true, tester: { name: 'Ana R.', accountId: ANA.accountId }, tcExecutor: null });
  });

  it('an unreadable file is reported, and saving replaces it', () => {
    writeFileSync(file, '{ not json');
    expect(readQaProfile(file)).toMatchObject({ exists: true, unreadable: true, tester: null });
    writeFileSync(file, '[1, 2]');
    expect(readQaProfile(file).unreadable).toBe(true);
    // A person without an accountId does not count.
    writeFileSync(file, JSON.stringify({ tester: { name: 'Ana' } }));
    expect(readQaProfile(file)).toMatchObject({ unreadable: false, tester: null });
    writeQaProfile({ tester: ANA, tcExecutor: null }, file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ tester: ANA });
  });

  it('the demo keeps its profile in its own folder', () => {
    const demoDir = demoDataDir(8799);
    expect(demoAppOptions(demoDir).profileFile).toBe(path.join(demoDir, 'avm-qa-profile.json'));
  });
});

describe('QA profile in the app', () => {
  const calls: { url: string; auth: string | null }[] = [];
  const people = [
    { displayName: 'Ana Ríos', accountId: ANA.accountId, accountType: 'atlassian', active: true },
    { displayName: 'Luis Torres', accountId: LUIS.accountId, accountType: 'atlassian', active: true },
    { displayName: 'Luis (former)', accountId: '712020:cccc-3333', accountType: 'atlassian', active: false },
    { displayName: 'Luis Bot', accountId: '557058:dddd-4444', accountType: 'app', active: true },
  ];
  const jira: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, auth: new Headers(init?.headers).get('authorization') });
    if (url.pathname === '/rest/api/3/myself') return Response.json(people[0]);
    if (url.pathname === '/rest/api/3/user/search') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      return Response.json(people.filter((p) => p.displayName.toLowerCase().includes(q)));
    }
    return Response.json({ issues: [] });
  };
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    // A slow check of the Mac still running when the profile is saved must not answer with the old profile.
    srv = await startServer({
      fetchImpl: jira,
      probeSetup: async () => {
        const facts = { ...readyFacts(), profile: profileFacts(srv.profileFile) };
        await new Promise((r) => setTimeout(r, 300));
        return facts;
      },
    });
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(() => srv.close());

  it('without Jira, it cannot take the tester or search people, and says why', async () => {
    const me = await srv.call('GET', '/api/jira/myself');
    expect([me.status, me.body.error]).toEqual([400, 'Primero conecta Jira (sitio, email y API token) en Tipos y ajustes']);
    expect((await srv.call('GET', '/api/jira/users?query=luis')).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('takes the tester from the Jira connection and finds the executor among active people', async () => {
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'secret' });
    const me = await srv.call('GET', '/api/jira/myself');
    expect(me.body).toEqual(ANA);
    expect(calls.at(-1)).toEqual({ url: '/rest/api/3/myself', auth: `Basic ${Buffer.from('qa@example.com:secret').toString('base64')}` });

    const found = await srv.call('GET', `/api/jira/users?query=${encodeURIComponent('luis')}`);
    // Former employees and apps are left out.
    expect(found.body).toEqual([LUIS]);
    expect(calls.at(-1)!.url).toBe('/rest/api/3/user/search?query=luis&maxResults=10');
    expect((await srv.call('GET', '/api/jira/users?query=l')).status).toBe(400);
  });

  it('saves the profile to its file and the setup check sees it, even with a check already running', async () => {
    void srv.call('POST', '/api/setup/check', {});
    await new Promise((r) => setTimeout(r, 50));
    expect((await srv.call('GET', '/api/profile')).body).toMatchObject({ exists: false, tester: null });
    const { status, body } = await srv.call('PUT', '/api/profile', { tester: ANA, tcExecutor: LUIS });
    expect(status).toBe(200);
    expect(body.profile).toMatchObject({ exists: true, tester: ANA, tcExecutor: LUIS });
    expect(JSON.parse(readFileSync(srv.profileFile, 'utf8'))).toEqual({ tester: ANA, tcExecutor: LUIS });
    expect(body.setup.checks.find((c: { id: string }) => c.id === 'profile')).toMatchObject({ status: 'ok', detail: 'Ana Ríos' });
    expect((await srv.call('GET', '/api/profile')).body).toMatchObject({ tester: ANA, tcExecutor: LUIS });
  });

  it('refuses a profile without a tester, or with something that is not an accountId, and leaves the file as it was', async () => {
    await srv.call('PUT', '/api/profile', { tester: ANA, tcExecutor: null });
    const before = readFileSync(srv.profileFile, 'utf8');
    const bad = await srv.call('PUT', '/api/profile', { tester: { name: 'Ana', accountId: 'ana@example.com' }, tcExecutor: null });
    expect([bad.status, bad.body.error]).toEqual([400, 'Datos inválidos (tester.accountId): no es un accountId de Jira']);
    expect((await srv.call('PUT', '/api/profile', { tester: { name: ' ', accountId: ANA.accountId }, tcExecutor: null })).status).toBe(400);
    expect((await srv.call('PUT', '/api/profile', { tcExecutor: LUIS })).status).toBe(400);
    expect((await srv.call('PUT', '/api/profile', { tester: ANA, tcExecutor: { name: 'Luis' } })).status).toBe(400);
    expect(readFileSync(srv.profileFile, 'utf8')).toBe(before);
  });
});
