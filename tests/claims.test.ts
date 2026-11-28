import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_FRESH_MS, claimFor, claimText, teamClaims } from '../src/shared/claims';
import { defaultQaConfig } from '../src/shared/orchestrator';

const DEFAULT_QA = defaultQaConfig();
import { ticketsToValidate } from '../src/shared/queue';
import { buildTeamFile, writeTeamFile } from '../src/server/team';
import type { Automation, QueueItem, TeamMember, TicketClaim } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.23.0): through the team folder, an app knows which tickets its teammates are
 * validating now, have queued, or already validated on a site, so two QAs do not validate the same
 * ticket twice:
 * - running and queued runs count only while the teammate's file is fresh (2 h: a live app writes it
 *   every hour); an older file means their app is closed;
 * - a teammate's validation is their newest finished run of the ticket on that site, not in test
 *   mode and not BLOCKED (nothing was tested), and only if newer than this app's own last one;
 * - "Validate all" lists those tickets unchecked and says why; the ticket card says it and asks a
 *   second click before launching one a teammate is running or has queued;
 * - a queued ticket is skipped when its turn comes if a teammate is validating it, or validated it
 *   on that site after it was queued.
 */

const QA = DEFAULT_QA.sites[0]!; // QA, env QA, On QA
const STG = DEFAULT_QA.sites[1]!; // STG, env STG, On Staging
const NOW = Date.parse('2026-11-27T15:00:00Z');
const MIN = 60_000;

const orch = (target: string, extra: Partial<Automation> = {}): Automation => ({
  id: `${target}-${extra.finishedAt ?? 'run'}-${extra.site ?? ''}`, kind: 'orchestrator', target, title: `QA orchestrator · ${target}`, env: 'QA', startedAt: NOW - 30 * MIN,
  finishedAt: NOW - 5 * MIN, verdict: 'PASSED', summary: 'ok', link: '', runId: null, pid: null, logFile: '', lang: 'es', translations: {}, dryRun: false,
  fullCoverage: false, site: 'qa', ticketType: 'Story', queued: null, details: null, ...extra,
});
const member = (name: string, automations: Automation[], extra: Partial<TeamMember> = {}): TeamMember => ({
  id: `${name}-0000-0000`, name, app: '1.23.0', updatedAt: NOW - 5 * MIN, file: '', me: false, types: [], runs: [], automations, queue: [], ...extra,
});
const claim = (c: Partial<TicketClaim>): TicketClaim => ({ key: 'AVM-1', state: 'validated', by: 'Ana', at: NOW, verdict: 'PASSED', site: 'qa', env: 'QA', ...c });

describe('What teammates are doing on tickets', () => {
  it('a teammate validating a ticket now, or with it queued, claims it while their file is fresh', () => {
    const luis = member('Luis', [orch('AVM-2', { finishedAt: null, verdict: null, startedAt: NOW - 12 * MIN })], {
      queue: [{ kind: 'orchestrator', target: 'AVM-3', site: 'qa', addedAt: NOW - 3 * MIN }, { kind: 'smoke', target: 'QA', site: 'qa', addedAt: NOW }],
    });
    expect(teamClaims([luis], NOW)).toEqual([
      { key: 'AVM-2', state: 'running', by: 'Luis', at: NOW - 12 * MIN, verdict: null, site: 'qa', env: 'QA' },
      { key: 'AVM-3', state: 'queued', by: 'Luis', at: NOW - 3 * MIN, verdict: null, site: 'qa', env: '' },
    ]);
    // Their app closed more than 2 h ago: what it was running or had queued no longer counts.
    expect(teamClaims([{ ...luis, updatedAt: NOW - CLAIM_FRESH_MS - 1 }], NOW)).toEqual([]);
    expect(teamClaims([{ ...luis, updatedAt: NOW - CLAIM_FRESH_MS }], NOW)).toHaveLength(2);
    // This app's own data is never a teammate's claim.
    expect(teamClaims([{ ...luis, me: true }], NOW)).toEqual([]);
  });

  it('a teammate\'s validation is their newest finished run per site; BLOCKED or test mode is none; it lasts even if their file is old', () => {
    const marta = member('Marta', [
      orch('AVM-4', { finishedAt: NOW - 3 * 24 * 60 * MIN, verdict: 'FAILED' }),
      orch('AVM-4', { finishedAt: NOW - 24 * 60 * MIN, verdict: 'PASSED W/F' }), // newest on QA
      orch('AVM-4', { finishedAt: NOW - 60 * MIN, verdict: 'BLOCKED', site: 'stg', env: 'STG' }), // newest on STG: nothing tested
      orch('AVM-4', { finishedAt: NOW - 2 * 24 * 60 * MIN, verdict: 'PASSED', site: 'stg', env: 'STG' }),
      orch('AVM-5', { finishedAt: NOW - 10 * MIN, verdict: 'PASSED', dryRun: true }),
    ], { updatedAt: NOW - 5 * 24 * 60 * MIN });
    expect(teamClaims([marta], NOW)).toEqual([
      { key: 'AVM-4', state: 'validated', by: 'Marta', at: NOW - 24 * 60 * MIN, verdict: 'PASSED W/F', site: 'qa', env: 'QA' },
    ]);
  });

  it('for a ticket: running first, then queued, then the newest validation on the site it would run on here, if newer than this app\'s own', () => {
    const claims = [
      claim({ by: 'Old', at: NOW - 60 * MIN }),
      claim({ by: 'New', at: NOW - 10 * MIN }),
      claim({ by: 'OnStg', at: NOW, site: 'stg', env: 'STG' }),
      claim({ key: 'AVM-2', state: 'queued', by: 'Queued', verdict: null }),
      claim({ key: 'AVM-2', state: 'running', by: 'Running', verdict: null }),
      claim({ key: 'AVM-2', by: 'Validated' }),
      // Another Mac named its site differently: the environment still matches.
      claim({ key: 'AVM-3', by: 'Elsewhere', site: 'qa-2', env: 'QA' }),
      claim({ key: 'AVM-6', by: 'OldRun', site: '', env: '' }),
    ];
    expect(claimFor(claims, 'AVM-1', QA)?.by).toBe('New');
    expect(claimFor(claims, 'AVM-1', STG)?.by).toBe('OnStg');
    expect(claimFor(claims, 'AVM-2', QA)?.by).toBe('Running');
    expect(claimFor(claims.filter((c) => c.state !== 'running'), 'AVM-2', QA)?.by).toBe('Queued');
    expect(claimFor(claims, 'AVM-3', QA)?.by).toBe('Elsewhere');
    expect(claimFor(claims, 'AVM-6', QA)).toBeNull();
    expect(claimFor(claims, 'AVM-9', QA)).toBeNull();
    // This app validated it after them: their validation is old news; before them, it still counts.
    expect(claimFor(claims, 'AVM-1', QA, NOW - 5 * MIN)).toBeNull();
    expect(claimFor(claims, 'AVM-1', QA, NOW - 30 * MIN)?.by).toBe('New');
    // Running and queued count whatever this app did before.
    expect(claimFor(claims, 'AVM-2', QA, NOW)?.by).toBe('Running');
  });

  it('says it in the app\'s language', () => {
    const at = Date.parse('2026-11-25T14:00:00');
    expect(claimText(claim({ state: 'running', by: 'Luis Torres', at: NOW - 12 * MIN - 30_000 }), 'es', NOW)).toBe('Luis Torres lo está validando · 12 min');
    expect(claimText(claim({ state: 'running', by: 'Luis Torres', at: NOW - 12 * MIN }), 'en', NOW)).toBe('Luis Torres is validating it · 12 min');
    expect(claimText(claim({ state: 'queued', by: 'Marta Gómez' }), 'es')).toBe('En la cola de Marta Gómez');
    expect(claimText(claim({ state: 'queued', by: 'Marta Gómez' }), 'en')).toBe("In Marta Gómez's queue");
    expect(claimText(claim({ by: 'Marta Gómez', at, verdict: 'PASSED' }), 'es')).toBe('Marta Gómez lo validó el 25/11/2026: PASSED');
    expect(claimText(claim({ by: 'Marta Gómez', at, verdict: 'FAILED' }), 'en')).toBe('Marta Gómez validated it on 11/25/2026: FAILED');
  });
});

describe('"Validate all" with a team', () => {
  const ticket = (key: string, status: string) => ({ key, summary: key, status, type: 'Story', priority: 'Medium', created: NOW - 24 * 60 * MIN, epic: '', blockedBy: [] });
  const base = {
    jira: { tickets: [ticket('AVM-1', 'On QA'), ticket('AVM-2', 'On QA'), ticket('AVM-3', 'On QA'), ticket('AVM-4', 'On Staging')] },
    automations: [] as Automation[],
    queue: { items: [] as QueueItem[], paused: {}, skipped: [], finished: [] },
    settings: { qa: DEFAULT_QA },
  } as unknown as Parameters<typeof ticketsToValidate>[0];
  const claims = [
    claim({ key: 'AVM-2', state: 'running', by: 'Luis', verdict: null }),
    claim({ key: 'AVM-3', state: 'queued', by: 'Luis', verdict: null }),
    // Validated on QA, but AVM-4 is in On Staging now: it still has to be validated there.
    claim({ key: 'AVM-4', by: 'Marta' }),
  ];

  it('lists the tickets a teammate is on, unchecked, with the claim', () => {
    const list = ticketsToValidate({ ...base, team: { claims } }, NOW);
    expect(list.map((c) => [c.ticket.key, c.suggested, c.claim?.by ?? null])).toEqual([
      ['AVM-4', true, null],
      ['AVM-1', true, null],
      ['AVM-2', false, 'Luis'],
      ['AVM-3', false, 'Luis'],
    ]);
    // Not in a team: as before.
    expect(ticketsToValidate(base, NOW).every((c) => c.suggested && c.claim === null)).toBe(true);
  });

  it('a teammate\'s validation newer than this app\'s last run unchecks it; a BLOCKED run of this app does not hide it', () => {
    const marta = claim({ key: 'AVM-1', by: 'Marta', at: NOW - 60 * MIN });
    const mine = (finishedAt: number, verdict: Automation['verdict']) => [orch('AVM-1', { finishedAt, verdict })];
    const pick = (automations: Automation[]) => ticketsToValidate({ ...base, automations, team: { claims: [marta] } }, NOW).find((c) => c.ticket.key === 'AVM-1')!;
    expect(pick([])).toMatchObject({ suggested: false, claim: { by: 'Marta' } });
    // This app ran it after Marta and it was BLOCKED: Marta's validation still stands.
    expect(pick(mine(NOW - 10 * MIN, 'BLOCKED'))).toMatchObject({ suggested: false, claim: { by: 'Marta' } });
    // This app validated it after Marta: its own rule applies (validated, so unchecked) and Marta's is not shown.
    expect(pick(mine(NOW - 10 * MIN, 'FAILED'))).toMatchObject({ suggested: false, claim: null });
  });
});

describe('Claims through the team folder', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-claims-'));
  const folder = path.join(root, 'QA Team');
  const tickets: Array<[string, string]> = [['AVM-1', 'On QA'], ['AVM-2', 'On QA'], ['AVM-3', 'On QA'], ['AVM-4', 'On Staging']];
  const jira: typeof fetch = async () =>
    Response.json({ issues: tickets.map(([key, status]) => ({ key, fields: { summary: `Ticket ${key}`, status: { name: status }, issuetype: { name: 'Story' }, priority: { name: 'Medium' }, created: '2026-11-01T10:00:00.000-0500' } })) });
  let srv: Awaited<ReturnType<typeof startServer>>;
  const started: string[] = [];
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: jira,
      launchClaude: async (job) => {
        started.push(job.prompt.split(/\s/)[1]!);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
  });
  afterEach(async () => {
    await srv.reset();
    for (const f of readdirSync(folder)) if (!f.startsWith('piter')) rmSync(path.join(folder, f));
    started.length = 0;
  });
  afterAll(() => srv.close());

  const state = async () => (await srv.call('GET', '/api/state')).body;
  const teammate = (name: string, automations: Automation[], updatedAt = Date.now(), queue: QueueItem[] = []) =>
    writeTeamFile(folder, buildTeamFile({ id: `${name.toLowerCase()}-0000-1111`, name }, '1.23.0', [], [], automations, updatedAt, queue));
  const finish = async (target: string) => {
    const a = (await state()).automations.find((x: Automation) => x.target === target && x.finishedAt === null);
    return srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'PASSED', summary: 'Done' });
  };

  it('the state carries the teammates\' claims, and this app shares what waits in its queue (what and where, nothing else)', async () => {
    const now = Date.now();
    teammate('Luis', [orch('AVM-2', { finishedAt: null, verdict: null, startedAt: now - 12 * MIN })]);
    await srv.call('GET', '/api/team');
    expect((await state()).team.claims).toEqual([{ key: 'AVM-2', state: 'running', by: 'Luis', at: now - 12 * MIN, verdict: null, site: 'qa', env: 'QA' }]);
    expect(ticketsToValidate(await state()).map((c) => [c.ticket.key, c.suggested])).toEqual([['AVM-4', true], ['AVM-1', true], ['AVM-2', false], ['AVM-3', true]]);

    expect((await srv.call('POST', '/api/orchestrator/AVM-1', {})).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-3', {})).status).toBe(202);
    const { ownFile } = (await srv.call('GET', '/api/team')).body;
    const mine = JSON.parse(readFileSync(path.join(folder, ownFile), 'utf8'));
    expect(mine.queue).toEqual([{ kind: 'orchestrator', target: 'AVM-3', site: 'qa', addedAt: expect.any(Number) }]);
  });

  it('a file from v1.22.0 (no queue) is still read', async () => {
    const file = buildTeamFile({ id: 'old-app-0000-1111', name: 'Old' }, '1.22.0', [], [], [orch('AVM-2', { finishedAt: null, verdict: null })]);
    const { queue: _none, ...v122 } = file;
    writeFileSync(path.join(folder, 'old--old-app-.qa-team.json'), JSON.stringify(v122));
    const { members, problems } = (await srv.call('GET', '/api/team')).body;
    expect(problems).toEqual([]);
    expect(members.find((m: TeamMember) => m.name === 'Old')).toMatchObject({ queue: [] });
    expect((await state()).team.claims.map((c: TicketClaim) => [c.key, c.by])).toEqual([['AVM-2', 'Old']]);
  });

  it('when its turn comes, a queued ticket a teammate is validating is skipped, saying who', async () => {
    expect((await srv.call('POST', '/api/orchestrator/AVM-1', {})).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-2', {})).status).toBe(202);
    expect((await srv.call('POST', '/api/orchestrator/AVM-3', {})).status).toBe(202);
    // Meanwhile Luis started AVM-2 on his Mac.
    teammate('Luis', [orch('AVM-2', { finishedAt: null, verdict: null, startedAt: Date.now() })]);
    await finish('AVM-1');
    await expect.poll(() => started).toEqual(['AVM-1', 'AVM-3']);
    expect((await state()).queue.skipped[0]).toMatchObject({ target: 'AVM-2', reason: 'Luis ya está validando AVM-2' });
  });

  it('a queued ticket a teammate validated on that site after it was queued is skipped; validated before, or on another site, it runs', async () => {
    expect((await srv.call('POST', '/api/orchestrator/AVM-1', {})).status).toBe(200);
    const { body } = await srv.call('POST', '/api/orchestrator/AVM-2', {});
    const queuedAt = body.queued.addedAt as number;
    expect((await srv.call('POST', '/api/orchestrator/AVM-3', {})).status).toBe(202);
    teammate('Marta', [
      orch('AVM-2', { finishedAt: queuedAt + 1, verdict: 'FAILED' }),
      orch('AVM-3', { finishedAt: queuedAt - 1, verdict: 'PASSED' }),
    ]);
    await finish('AVM-1');
    await expect.poll(() => started).toEqual(['AVM-1', 'AVM-3']);
    expect((await state()).queue.skipped[0]).toMatchObject({ target: 'AVM-2', reason: 'Marta validó AVM-2 después de que entró en la cola: FAILED' });
  });
});
