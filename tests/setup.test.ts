import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeJob } from '../src/server/claudeRunner';
import { checkSkill, installedSkills, parseAuthStatus, parsePluginList, readyFacts, type SetupFacts } from '../src/server/setup';
import type { SetupState } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.19.0): the app checks what this Mac has for runs with Claude Code (installed, signed
 * in, the configured skills, Claude in Chrome, the QA profile, Jira) and shows it. A run that cannot
 * work is refused before it is recorded or queued, saying what is missing; a check that could not be
 * done lets it try. A configured skill Claude Code has under another plugin prefix is switched to it.
 */

const SKILLS = ['avm-qa-skills:avm-qa-orchestrator', 'avm-qa-skills:avm-smoke-tester', 'avm-qa-skills:avm-regression-runner'];

describe('What Claude Code reports', () => {
  it('reads the sign-in from `claude auth status`, signed in or out, and nothing from anything else', () => {
    expect(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true);
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toBe(false);
    expect(parseAuthStatus('error: unknown command "auth"')).toBeNull();
    expect(parseAuthStatus('{"authMethod": "none"}')).toBeNull();
  });

  it('takes the enabled plugins from `claude plugin list --json`', () => {
    const out = JSON.stringify([
      { id: 'avm-qa-skills@synced', enabled: true, installPath: '/p/avm' },
      { id: 'old@market', enabled: false, installPath: '/p/old' },
      { id: 'no-path@market', enabled: true },
    ]);
    expect(parsePluginList(out)).toEqual([{ name: 'avm-qa-skills', dir: '/p/avm' }]);
    expect(parsePluginList('Plugins:\n  none')).toBeNull();
    expect(parsePluginList('{"plugins": []}')).toBeNull();
  });

  it('finds the plugins\' skills with their prefix, and the personal, synced and runs-folder ones bare', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qa-skills-'));
    const skill = (dir: string, body = '') => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), body);
    };
    skill(path.join(root, 'plugin/skills/avm-qa-orchestrator'), '---\nname: avm-qa-orchestrator\ndescription: x\n---\n');
    skill(path.join(root, 'plugin/skills/folder-name'), '---\nname: "named-in-file"\n---\n');
    mkdirSync(path.join(root, 'plugin/skills/not-a-skill'), { recursive: true });
    skill(path.join(root, 'home/.claude/skills/mine'));
    skill(path.join(root, 'home/.claude/skills/synced/org-1/avm-smoke-tester'));
    skill(path.join(root, 'runs/.claude/skills/local'));
    const found = installedSkills([{ name: 'avm-qa-skills', dir: path.join(root, 'plugin') }], path.join(root, 'home'), path.join(root, 'runs'));
    expect(found.map((s) => `${s.name}${s.plugin ? ' (plugin)' : ''}`).sort()).toEqual([
      'avm-qa-skills:avm-qa-orchestrator (plugin)', 'avm-qa-skills:named-in-file (plugin)', 'avm-smoke-tester', 'local', 'mine',
    ]);
    // Nothing installed at all is an empty list, not an error.
    expect(installedSkills([], path.join(root, 'nobody'), path.join(root, 'nothing'))).toEqual([]);
  });

  it('matches a prefixed skill exactly and a bare one by name, and suggests the one plugin that has it', () => {
    const installed = [
      { name: 'avm-qa-skills:avm-qa-orchestrator', plugin: true },
      { name: 'avm-smoke-tester', plugin: false },
      { name: 'one:dup', plugin: true },
      { name: 'two:dup', plugin: true },
    ];
    expect(checkSkill('/avm-qa-skills:avm-qa-orchestrator', installed)).toEqual({ status: 'ok' });
    expect(checkSkill('/avm-qa-orchestrator', installed)).toEqual({ status: 'ok' });
    expect(checkSkill('/avm-smoke-tester', installed)).toEqual({ status: 'ok' });
    // Another prefix: the plugin's name is suggested.
    expect(checkSkill('/anthropic-skills:avm-qa-orchestrator', installed)).toEqual({ status: 'missing', suggestion: '/avm-qa-skills:avm-qa-orchestrator' });
    // Only a plugin's name is certain enough to switch to; a personal skill is not suggested.
    expect(checkSkill('/x:avm-smoke-tester', installed)).toEqual({ status: 'missing' });
    // Two plugins have it: the app does not guess.
    expect(checkSkill('/dup', installed)).toEqual({ status: 'ok' });
    expect(checkSkill('/three:dup', installed)).toEqual({ status: 'missing' });
    expect(checkSkill('/avm-regression-runner', installed)).toEqual({ status: 'missing' });
    expect(checkSkill('/avm-regression-runner', null)).toEqual({ status: 'unknown' });
  });
});

describe('Setup check in the app', () => {
  let facts: SetupFacts = readyFacts(SKILLS);
  let probes = 0;
  const jobs: ClaudeJob[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: async () =>
        Response.json({
          issues: [{ key: 'AVM-1', fields: { summary: 'One', status: { name: 'On QA' }, issuetype: { name: 'Story' }, priority: { name: 'Medium' }, created: '2026-11-01T10:00:00.000-0500' } }],
        }),
      probeSetup: async () => {
        probes++;
        return structuredClone(facts);
      },
      launchClaude: async (job) => {
        jobs.push(job);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
  });
  afterEach(async () => {
    facts = readyFacts(SKILLS);
    await srv.call('POST', '/api/setup/check', {});
    await srv.reset();
    jobs.length = 0;
  });
  afterAll(() => srv.close());
  beforeAll(async () => {
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
  });

  const setup = async (): Promise<SetupState> => (await srv.call('GET', '/api/state')).body.setup;
  const statuses = (s: SetupState) => Object.fromEntries(s.checks.map((c) => [c.id, c.status]));

  it('shows a ready Mac, with what it found', async () => {
    const s = await setup();
    expect(s.ready).toBe(true);
    expect(statuses(s)).toEqual({ claude: 'ok', login: 'ok', skills: 'ok', chrome: 'ok', profile: 'ok', jira: 'ok' });
    expect(s.checks.find((c) => c.id === 'jira')!.detail).toBe('example.atlassian.net');
    expect(s.checks.filter((c) => c.required).map((c) => c.id)).toEqual(['claude', 'login', 'skills']);
    expect(s.checks.find((c) => c.id === 'claude')!.detail).toBe('simulated');
    expect(s.checks.find((c) => c.id === 'profile')!.detail).toBe('QA');
    expect(s.skills.map((k) => [k.kind, k.status])).toEqual([['orchestrator', 'ok'], ['smoke', 'ok'], ['regression', 'ok']]);
  });

  it('without Claude Code, refuses every run before recording or queueing it, and says so in the app language', async () => {
    facts = { ...facts, claude: null, loggedIn: null, skills: null };
    await srv.call('POST', '/api/setup/check', {});
    const smoke = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect(smoke.status).toBe(503);
    expect(smoke.body.error).toBe('Claude Code no está instalado en esta Mac. Mira Tipos y ajustes → Preparar esta Mac');
    const state = (await srv.call('GET', '/api/state')).body;
    expect(state.automations).toEqual([]);
    expect(state.queue.items).toEqual([]);
    expect(jobs).toEqual([]);
    expect(state.setup.ready).toBe(false);
    // What depends on Claude could not be checked: it shows as unknown, not as missing.
    expect(statuses(state.setup)).toMatchObject({ claude: 'missing', login: 'unknown', skills: 'unknown' });

    const settings = state.settings;
    await srv.call('PUT', '/api/settings', { ...settings, language: 'en' });
    expect((await srv.call('POST', '/api/regression', { run: '' })).body.error).toBe('Claude Code is not installed on this Mac. See Types & settings → Set up this Mac');
    await srv.call('PUT', '/api/settings', settings);
  });

  it('signed out, refuses the run; once signed in, the same click launches it with no recheck by hand', async () => {
    facts = { ...facts, loggedIn: false };
    await srv.call('POST', '/api/setup/check', {});
    const refused = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect([refused.status, refused.body.error]).toEqual([503, 'Claude Code no tiene la sesión iniciada en esta Mac. Mira Tipos y ajustes → Preparar esta Mac']);
    facts = readyFacts(SKILLS);
    const launched = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect(launched.status).toBe(200);
    expect(jobs).toHaveLength(1);
  });

  it('a run asked for while its site is busy is refused too, not queued; and so is "Validate all"', async () => {
    expect((await srv.call('POST', '/api/smoke', { site: 'stg' })).status).toBe(200);
    facts = { ...facts, loggedIn: false };
    await srv.call('POST', '/api/setup/check', {});
    expect((await srv.call('POST', '/api/regression', { run: '' })).status).toBe(503);
    expect((await srv.call('POST', '/api/queue', { keys: ['AVM-1'] })).status).toBe(503);
    expect((await srv.call('GET', '/api/state')).body.queue.items).toEqual([]);
    facts = readyFacts(SKILLS);
    expect((await srv.call('POST', '/api/queue', { keys: ['AVM-1'] })).status).toBe(200);
  });

  it('a missing skill refuses only the runs that use it', async () => {
    facts = readyFacts(SKILLS.filter((s) => !s.endsWith('regression-runner')));
    await srv.call('POST', '/api/setup/check', {});
    expect((await srv.call('POST', '/api/regression', { run: '' })).body.error).toBe(
      'Claude Code no tiene la skill avm-qa-skills:avm-regression-runner. Mira Tipos y ajustes → Preparar esta Mac',
    );
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
    const s = await setup();
    expect(s.checks.find((c) => c.id === 'skills')).toMatchObject({ status: 'missing', detail: 'avm-qa-skills:avm-regression-runner' });
    expect(s.skills.find((k) => k.kind === 'regression')!.status).toBe('missing');
  });

  it('what could not be checked, or is only advice, does not stop a run', async () => {
    facts = { ...facts, loggedIn: null, skills: null, chrome: false, profile: { status: 'invalid' } };
    await srv.call('POST', '/api/setup/check', {});
    const s = await setup();
    expect(s.ready).toBe(true);
    expect(statuses(s)).toMatchObject({ login: 'unknown', skills: 'unknown', chrome: 'missing', profile: 'invalid' });
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
  });

  it('switches a skill Claude Code has under another prefix, and says so until the name changes again', async () => {
    const { settings } = (await srv.call('GET', '/api/state')).body;
    await srv.call('PUT', '/api/settings', { ...settings, qa: { ...settings.qa, skills: { ...settings.qa.skills, orchestrator: '/anthropic-skills:avm-qa-orchestrator' } } });
    const { body } = await srv.call('POST', '/api/setup/check', {});
    expect(body.settings.qa.skills.orchestrator).toBe('/avm-qa-skills:avm-qa-orchestrator');
    expect(body.setup.skills[0]).toMatchObject({ kind: 'orchestrator', status: 'ok', renamedFrom: '/anthropic-skills:avm-qa-orchestrator' });
    // A name the tester chose afterwards is theirs: the note goes away.
    await srv.call('PUT', '/api/settings', { ...body.settings, qa: { ...body.settings.qa, skills: { ...body.settings.qa.skills, orchestrator: '/avm-qa-orchestrator' } } });
    expect((await setup()).skills[0]).toEqual({ kind: 'orchestrator', name: '/avm-qa-orchestrator', status: 'ok' });
  });

  it('a recent passing check is trusted; "check again" asks the Mac again', async () => {
    const before = probes;
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect(probes).toBe(before);
    await srv.call('POST', '/api/setup/check', {});
    expect(probes).toBe(before + 1);
  });

  it('a queued run whose Mac stops being ready pauses its site instead of being dropped', async () => {
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
    expect((await srv.call('POST', '/api/regression', { run: '' })).status).toBe(200);
    const queued = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(queued.status).toBe(202);
    facts = { ...facts, loggedIn: false };
    await srv.call('POST', '/api/setup/check', {});
    // The regression (on STG) ends: the queued STG smoke cannot start.
    const regression = (await srv.call('GET', '/api/state')).body.automations.find((a: { kind: string }) => a.kind === 'regression');
    await srv.call('POST', `/api/automation/${regression.id}/result`, { verdict: 'GO', summary: 'ok' });
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = (await srv.call('GET', '/api/state')).body;
      if (state.queue.paused.stg) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state.queue.paused.stg).toBe('Claude Code no tiene la sesión iniciada en esta Mac. Mira Tipos y ajustes → Preparar esta Mac');
    expect(state.queue.items.map((q: { kind: string; site: string }) => `${q.kind}@${q.site}`)).toEqual(['smoke@stg']);
    expect(jobs).toHaveLength(2);
    await srv.call('POST', '/api/queue/resume', { site: 'stg' });
  });
});
