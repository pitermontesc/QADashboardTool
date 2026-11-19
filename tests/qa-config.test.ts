import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { defaultQaConfig } from '../src/shared/orchestrator';
import type { QaConfig } from '../src/shared/types';
import { extraIssues, fakeJira, startServer } from './helpers';

/** Sites, skills and domains come from the settings, not from the code. */
describe('Configurable sites and skills', () => {
  const prompts: string[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  const custom: QaConfig = {
    sites: [
      { id: 'qa', name: 'QA', url: 'https://qa.example.com', env: 'QA', jiraStatus: 'On QA' },
      { id: 'uat', name: 'UAT', url: 'https://uat.example.com/app', env: 'UAT', jiraStatus: 'Ready for UAT' },
    ],
    regressionSiteId: 'uat',
    skills: { orchestrator: '/team:validate', smoke: '/team:smoke', regression: '/team:regression' },
    testRunHosts: ['tests.example.com'],
  };
  const saveQa = async (qa: unknown) => {
    const { body } = await srv.call('GET', '/api/state');
    return srv.call('PUT', '/api/settings', { ...body.settings, qa });
  };

  beforeAll(async () => {
    extraIssues.push({ key: 'AVM-300', summary: 'Checkout UAT', status: 'Ready for UAT' });
    srv = await startServer({
      fetchImpl: fakeJira,
      launchClaude: async (job) => {
        prompts.push(job.prompt);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(async () => {
    extraIssues.length = 0;
    await srv.close();
  });
  afterEach(async () => {
    prompts.length = 0;
    for (const a of (await srv.call('GET', '/api/state')).body.automations) {
      if (a.finishedAt === null) await srv.call('POST', `/api/automation/${a.id}/stop`, {});
    }
  });

  it('when not configured, uses the usual sites and skills', async () => {
    expect((await srv.call('GET', '/api/state')).body.settings.qa).toEqual(defaultQaConfig());
    const { body } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(body).toMatchObject({ target: 'STG', env: 'STG' });
    expect(prompts[0]).toMatch(/^\/avm-qa-skills:avm-smoke-tester run smoke on STG \(https:\/\/staging\.alpinevm\.com\)/);
  });

  it('launches the smoke on a custom site with its URL, environment and skill', async () => {
    expect((await saveQa(custom)).status).toBe(200);
    const { status, body } = await srv.call('POST', '/api/smoke', { site: 'uat' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'smoke', target: 'UAT', env: 'UAT' });
    expect(prompts[0]).toMatch(/^\/team:smoke run smoke on UAT \(https:\/\/uat\.example\.com\/app\)/);
    // A site that no longer exists is rejected, naming the existing ones (in Spanish, the default language).
    const gone = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(gone.status).toBe(400);
    expect(gone.body.error).toBe('Ese sitio no existe: elige QA o UAT');
  });

  it('the Jira status decides whether a ticket is orchestrated and in which environment', async () => {
    await saveQa(custom);
    const { status, body } = await srv.call('POST', '/api/orchestrator/AVM-300', {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ target: 'AVM-300', env: 'UAT' });
    expect(prompts[0]).toMatch(/^\/team:validate AVM-300/);
    // "On Staging" is no longer a ready status: no site uses it.
    const refused = await srv.call('POST', '/api/orchestrator/AVM-102', {});
    expect(refused.status).toBe(409);
    const { body: tickets } = await srv.call('GET', '/api/state');
    const avm102 = tickets.jira.tickets.find((t: { key: string }) => t.key === 'AVM-102');
    expect(refused.body.error).toBe(`AVM-102 está en "${avm102.status}"; el orquestador es para tickets en On QA o Ready for UAT`);
  });

  it('the regression uses the configured skill, site and domains', async () => {
    await saveQa(custom);
    const ok = await srv.call('POST', '/api/regression', { run: 'https://app.tests.example.com/projects/x/runs/1' });
    expect(ok.status).toBe(200);
    expect(ok.body.env).toBe('UAT');
    expect(prompts[0]).toMatch(/^\/team:regression https:\/\/app\.tests\.example\.com\/projects\/x\/runs\/1/);
    expect((await srv.call('POST', '/api/regression', { run: 'https://app.testomat.io/projects/x/runs/1' })).status).toBe(400);
  });

  it('rejects invalid configurations without touching the saved one', async () => {
    await saveQa(custom);
    const site = custom.sites[0]!;
    const bad: Array<[string, unknown]> = [
      ['skill with spaces', { ...custom, skills: { ...custom.skills, smoke: '/team:smoke; rm -rf ~' } }],
      ['skill without slash', { ...custom, skills: { ...custom.skills, orchestrator: 'team:validate' } }],
      ['non-http URL', { ...custom, sites: [{ ...site, url: 'javascript:alert(1)' }, custom.sites[1]] }],
      ['name with quotes', { ...custom, sites: [{ ...site, name: "QA'" }, custom.sites[1]] }],
      ['id with uppercase', { ...custom, sites: [{ ...site, id: 'QA' }, custom.sites[1]] }],
      ['repeated ids', { ...custom, sites: [site, { ...custom.sites[1], id: 'qa' }] }],
      ['repeated Jira status', { ...custom, sites: [site, { ...custom.sites[1], jiraStatus: 'on qa' }] }],
      ['no sites', { ...custom, sites: [] }],
      ['regression on a site that does not exist', { ...custom, regressionSiteId: 'prod' }],
      ['invalid domain', { ...custom, testRunHosts: ['https://x'] }],
    ];
    for (const [why, qa] of bad) expect((await saveQa(qa)).status, why).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings.qa).toEqual(custom);
  });

  it('the assistant only proposes the smoke on sites that exist', async () => {
    await saveQa(custom);
    const answers = [{ type: 'run_smoke', site: 'uat' }, { type: 'run_smoke', site: 'stg' }];
    const srv2 = await startServer({ fetchImpl: fakeJira, assistant: async () => ({ reply: 'Ok', actions: answers }) });
    try {
      const { body } = await srv2.call('GET', '/api/state');
      await srv2.call('PUT', '/api/settings', { ...body.settings, qa: custom });
      const reply = await srv2.call('POST', '/api/assistant', { messages: [{ role: 'user', text: 'smoke' }] });
      expect(reply.body.actions).toEqual([{ type: 'run_smoke', site: 'uat' }]);
    } finally {
      await srv2.close();
    }
  });
});

describe('Data saved before this version', () => {
  it('without a site configuration, the defaults are used', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
    writeFileSync(file, JSON.stringify({ version: 1, settings: { types: [{ id: 't0', name: 'Smoke', major: true, color: '#000000' }], envs: ['QA'], ticketBase: '', language: 'es' }, runs: [] }));
    expect(new Store(file).getState().settings.qa).toEqual(defaultQaConfig());
  });
});
