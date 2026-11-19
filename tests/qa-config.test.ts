import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { defaultQaConfig } from '../src/shared/orchestrator';
import type { QaConfig } from '../src/shared/types';
import { extraIssues, fakeJira, startServer } from './helpers';

/** Sitios, skills y dominios salen de los ajustes, no del código. */
describe('Sitios y skills configurables', () => {
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

  it('sin configurar usa los sitios y skills de siempre', async () => {
    expect((await srv.call('GET', '/api/state')).body.settings.qa).toEqual(defaultQaConfig());
    const { body } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(body).toMatchObject({ target: 'STG', env: 'STG' });
    expect(prompts[0]).toMatch(/^\/avm-qa-skills:avm-smoke-tester run smoke on STG \(https:\/\/staging\.alpinevm\.com\)/);
  });

  it('lanza el smoke en un sitio propio con su URL, ambiente y skill', async () => {
    expect((await saveQa(custom)).status).toBe(200);
    const { status, body } = await srv.call('POST', '/api/smoke', { site: 'uat' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'smoke', target: 'UAT', env: 'UAT' });
    expect(prompts[0]).toMatch(/^\/team:smoke run smoke on UAT \(https:\/\/uat\.example\.com\/app\)/);
    // El sitio que ya no existe se rechaza, nombrando los que hay.
    const gone = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(gone.status).toBe(400);
    expect(gone.body.error).toBe('Ese sitio no existe: elige QA o UAT');
  });

  it('el estado de Jira decide si un ticket se orquesta y en qué ambiente', async () => {
    await saveQa(custom);
    const { status, body } = await srv.call('POST', '/api/orchestrator/AVM-300', {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ target: 'AVM-300', env: 'UAT' });
    expect(prompts[0]).toMatch(/^\/team:validate AVM-300/);
    // «On Staging» ya no es un estado listo: ningún sitio lo usa.
    const refused = await srv.call('POST', '/api/orchestrator/AVM-102', {});
    expect(refused.status).toBe(409);
    const { body: tickets } = await srv.call('GET', '/api/state');
    const avm102 = tickets.jira.tickets.find((t: { key: string }) => t.key === 'AVM-102');
    expect(refused.body.error).toBe(`AVM-102 está en "${avm102.status}"; el orquestador es para tickets en On QA o Ready for UAT`);
  });

  it('la regresión usa el skill, el sitio y los dominios configurados', async () => {
    await saveQa(custom);
    const ok = await srv.call('POST', '/api/regression', { run: 'https://app.tests.example.com/projects/x/runs/1' });
    expect(ok.status).toBe(200);
    expect(ok.body.env).toBe('UAT');
    expect(prompts[0]).toMatch(/^\/team:regression https:\/\/app\.tests\.example\.com\/projects\/x\/runs\/1/);
    expect((await srv.call('POST', '/api/regression', { run: 'https://app.testomat.io/projects/x/runs/1' })).status).toBe(400);
  });

  it('rechaza configuraciones inválidas sin tocar la guardada', async () => {
    await saveQa(custom);
    const site = custom.sites[0]!;
    const bad: Array<[string, unknown]> = [
      ['skill con espacios', { ...custom, skills: { ...custom.skills, smoke: '/team:smoke; rm -rf ~' } }],
      ['skill sin barra', { ...custom, skills: { ...custom.skills, orchestrator: 'team:validate' } }],
      ['URL no http', { ...custom, sites: [{ ...site, url: 'javascript:alert(1)' }, custom.sites[1]] }],
      ['nombre con comillas', { ...custom, sites: [{ ...site, name: "QA'" }, custom.sites[1]] }],
      ['id con mayúsculas', { ...custom, sites: [{ ...site, id: 'QA' }, custom.sites[1]] }],
      ['ids repetidos', { ...custom, sites: [site, { ...custom.sites[1], id: 'qa' }] }],
      ['estado de Jira repetido', { ...custom, sites: [site, { ...custom.sites[1], jiraStatus: 'on qa' }] }],
      ['sin sitios', { ...custom, sites: [] }],
      ['regresión en un sitio que no existe', { ...custom, regressionSiteId: 'prod' }],
      ['dominio inválido', { ...custom, testRunHosts: ['https://x'] }],
    ];
    for (const [why, qa] of bad) expect((await saveQa(qa)).status, why).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings.qa).toEqual(custom);
  });

  it('el asistente solo propone el smoke en sitios que existen', async () => {
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

describe('Datos guardados antes de esta versión', () => {
  it('sin configuración de sitios, toman los valores por defecto', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
    writeFileSync(file, JSON.stringify({ version: 1, settings: { types: [{ id: 't0', name: 'Smoke', major: true, color: '#000000' }], envs: ['QA'], ticketBase: '', language: 'es' }, runs: [] }));
    expect(new Store(file).getState().settings.qa).toEqual(defaultQaConfig());
  });
});
