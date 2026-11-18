import { readFileSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orchestratorCommand, regressionCommand } from '../src/server/orchestrator';
import { Store } from '../src/server/store';
import { fakeJira, lastBoardJql, startServer } from './helpers';

const RUN = { date: '2026-11-17', typeId: 't0', title: '  Smoke release 2.14 ', result: 'passed', passed: 20, failed: 0 };

describe('API', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira });
  });
  afterAll(() => srv.close());

  it('arranca con tipos por defecto y sin registros', async () => {
    const { body } = await srv.call('GET', '/api/state');
    expect(body.runs).toEqual([]);
    expect(body.settings.types.filter((t: { major: boolean }) => t.major).map((t: { name: string }) => t.name)).toEqual(['Smoke', 'Regression']);
    expect(body.jira).toMatchObject({ hasToken: false, tickets: [] });
  });

  it('crea, edita y borra registros, y los persiste en disco', async () => {
    const created = await srv.call('POST', '/api/runs', RUN);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Smoke release 2.14', blocked: null, ticket: '', notes: '' });

    const updated = await srv.call('PUT', `/api/runs/${created.body.id}`, { ...RUN, result: 'failed', failed: 2 });
    expect(updated.body).toMatchObject({ id: created.body.id, createdAt: created.body.createdAt, result: 'failed', failed: 2 });
    expect(new Store(srv.file).getState().runs).toHaveLength(1);

    expect((await srv.call('DELETE', `/api/runs/${created.body.id}`)).status).toBe(204);
    expect((await srv.call('DELETE', `/api/runs/${created.body.id}`)).status).toBe(404);
    expect(new Store(srv.file).getState().runs).toHaveLength(0);
  });

  it('rechaza datos inválidos con un mensaje claro', async () => {
    const noTitle = await srv.call('POST', '/api/runs', { ...RUN, title: '   ' });
    expect(noTitle).toMatchObject({ status: 400, body: { error: expect.stringContaining('título') } });
    expect((await srv.call('POST', '/api/runs', { ...RUN, result: 'unknown' })).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', { ...RUN, passed: -1 })).status).toBe(400);
    expect((await srv.call('PUT', '/api/settings', { types: [], envs: [] })).status).toBe(400);
    expect((await srv.call('PUT', '/api/runs/nope', RUN)).status).toBe(404);
  });

  it('solo acepta peticiones locales', async () => {
    expect((await srv.call('GET', '/api/state', undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await srv.call('GET', '/api/state', undefined, { Origin: 'http://localhost:5173' })).status).toBe(200);
  });

  it('importa un respaldo y reemplaza los datos', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const backup = { ...state.settings, envs: ['QA'], runs: [{ ...RUN, id: 'old-1', createdAt: 5, title: 'Importado' }] };
    const { status, body } = await srv.call('POST', '/api/import', backup);
    expect(status).toBe(200);
    expect(body.runs).toMatchObject([{ id: 'old-1', title: 'Importado' }]);
    expect(body.settings.envs).toEqual(['QA']);
    expect((await srv.call('POST', '/api/import', { runs: 'x' })).status).toBe(400);
  });

  it('carga tickets de Jira sin exponer nunca el token', async () => {
    expect((await srv.call('POST', '/api/jira/refresh', {})).status).toBe(400); // sin configurar
    expect((await srv.call('GET', '/api/state')).body.jira.connection).toBe('none');

    const config = { site: 'https://example.atlassian.net/', email: 'qa@example.com', jql: '', token: 'bad' };
    expect((await srv.call('PUT', '/api/jira/config', config)).body.connection).toBe('pending');
    const rejected = await srv.call('POST', '/api/jira/refresh', {});
    expect(rejected).toMatchObject({ status: 502, body: { error: expect.stringContaining('credenciales') } });
    expect((await srv.call('GET', '/api/state')).body.jira).toMatchObject({
      connection: 'error', error: expect.stringContaining('credenciales'),
    });

    const saved = await srv.call('PUT', '/api/jira/config', { ...config, token: 'good' });
    expect(saved.body).toMatchObject({ site: 'https://example.atlassian.net', hasToken: true });
    expect(saved.body.jql).toContain('currentUser()'); // JQL por defecto
    expect(JSON.stringify(saved.body)).not.toContain('good');

    expect(saved.body).toMatchObject({ connection: 'pending', error: null });
    const refreshed = await srv.call('POST', '/api/jira/refresh', {});
    expect(refreshed.body).toMatchObject({ connection: 'connected', error: null });
    expect(refreshed.body.tickets).toEqual([
      { key: 'AVM-101', summary: 'Work order totals', status: 'On QA', type: 'Story' },
      { key: 'AVM-102', summary: 'Vendor <import> & export', status: 'Test', type: 'Bug' },
    ]);

    // Guardar sin token conserva el anterior; un JQL inválido devuelve el detalle de Jira.
    await srv.call('PUT', '/api/jira/config', { ...config, token: '', jql: 'BAD' });
    const badJql = await srv.call('POST', '/api/jira/refresh', {});
    expect(badJql.body.error).toContain('JQL mal formado');

    expect(JSON.stringify((await srv.call('GET', '/api/state')).body)).not.toContain('"token"');
    expect(readFileSync(srv.file, 'utf8')).toContain('"token": "good"');
    if (process.platform !== 'win32') expect(statSync(srv.file).mode & 0o777).toBe(0o600);
  });

  it('carga los tickets de un board pegando su link', async () => {
    const board =
      'https://example.atlassian.net/jira/software/projects/AVM/boards/1?filter=assignee+IN+%28abc%2C+empty%29&groupBy=none';
    const saved = await srv.call('PUT', '/api/jira/config', {
      site: '', email: 'qa@example.com', board, jql: 'assignee WAS currentUser() AND updated >= -14d ORDER BY updated DESC', token: 'good',
    });
    // El sitio sale del board y el JQL por defecto deja de aplicarse.
    expect(saved.body).toMatchObject({ site: 'https://example.atlassian.net', board, jql: '' });

    const refreshed = await srv.call('POST', '/api/jira/refresh', {});
    expect(refreshed.body.tickets).toHaveLength(60);
    expect(lastBoardJql).toBe('(assignee IN (abc, empty)) AND (statusCategory != Done)');

    await srv.call('PUT', '/api/jira/config', { site: '', email: 'qa@example.com', board, jql: 'type = Bug ORDER BY key', token: '' });
    await srv.call('POST', '/api/jira/refresh', {});
    expect(lastBoardJql).toBe('(assignee IN (abc, empty)) AND (type = Bug) AND (statusCategory != Done)');

    const bad = await srv.call('PUT', '/api/jira/config', { site: '', email: 'qa@example.com', board: 'https://example.com/x', jql: '' });
    expect(bad.status).toBe(400);
  });
});

/** Comando sin la instrucción final para reportar el resultado al dashboard. */
const withoutReport = (command: string): string => command.replace(/ -- Al terminar.*'$/, "'");

describe('Orquestador QA', () => {
  const launched: string[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira, launchTerminal: async (command) => void launched.push(command) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());

  it('solo se lanza para tickets cargados en On QA u On Staging', async () => {
    expect(await srv.call('POST', '/api/orchestrator/AVM-101', {})).toMatchObject({ status: 200, body: { key: 'AVM-101' } });
    expect((await srv.call('POST', '/api/orchestrator/AVM-102', {})).status).toBe(409); // estado "Test"
    expect((await srv.call('POST', '/api/orchestrator/AVM-999', {})).status).toBe(404);
    expect((await srv.call('POST', `/api/orchestrator/${encodeURIComponent("AVM-1'; rm -rf ~")}`, {})).status).toBe(400);
    expect(launched).toEqual(["claude '/avm-qa-orchestrator AVM-101'"]);
    launched.length = 0;
  });

  it('lanza la regresión con el test run de testomat.io o sin él', async () => {
    expect((await srv.call('POST', '/api/regression', { run: '#b333fb92' })).status).toBe(200);
    expect((await srv.call('POST', '/api/regression', { run: 'https://app.testomat.io/projects/avm/runs/b333fb92' })).status).toBe(200);
    expect((await srv.call('POST', '/api/regression', {})).status).toBe(200);
    expect((await srv.call('POST', '/api/regression', { run: "#abc'; rm -rf ~" })).status).toBe(400);
    expect((await srv.call('POST', '/api/regression', { run: 'https://evil.example/runs/1' })).status).toBe(400);
    expect(launched.map(withoutReport)).toEqual([
      "claude '/avm-qa-skills:avm-regression-runner #b333fb92'",
      "claude '/avm-qa-skills:avm-regression-runner https://app.testomat.io/projects/avm/runs/b333fb92'",
      "claude '/avm-qa-skills:avm-regression-runner'",
    ]);
  });

  it('lanza el smoke tester en QA o STG', async () => {
    launched.length = 0;
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
    expect((await srv.call('POST', '/api/smoke', { site: 'stg' })).status).toBe(200);
    expect((await srv.call('POST', '/api/smoke', {})).status).toBe(400);
    expect((await srv.call('POST', '/api/smoke', { site: 'prod' })).status).toBe(400);
    expect(launched.map(withoutReport)).toEqual([
      "claude '/avm-qa-skills:avm-smoke-tester run smoke on QA (https://qa.alpinevm.com)'",
      "claude '/avm-qa-skills:avm-smoke-tester run smoke on STG (https://staging.alpinevm.com)'",
    ]);
  });

  it('refleja en el dashboard el resultado que Claude reporta al terminar', async () => {
    launched.length = 0;
    const { body: automation } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    expect(automation).toMatchObject({ kind: 'smoke', target: 'STG', env: 'Staging', finishedAt: null, verdict: null });
    // El prompt le dice a Claude adónde reportar; se usa esa misma URL.
    const reportUrl = new URL(launched[0]!.match(/POST JSON a (\S+)/)![1]!);
    expect(reportUrl.pathname).toBe(`/api/automation/${automation.id}/result`);

    expect((await srv.call('POST', reportUrl.pathname, { verdict: 'maybe' })).status).toBe(400);
    const report = { verdict: 'no go', passed: 18, failed: 2, bugs: 1, summary: 'Mass Upload falla en el paso 3', link: 'https://example.atlassian.net/browse/AVM-900' };
    const done = await srv.call('POST', reportUrl.pathname, report);
    expect(done).toMatchObject({ status: 200, body: { verdict: 'NO-GO', summary: 'Mass Upload falla en el paso 3' } });
    expect((await srv.call('POST', reportUrl.pathname, report)).status).toBe(409);

    const { body: state } = await srv.call('GET', '/api/state');
    expect(state.automations[0]).toMatchObject({ id: automation.id, verdict: 'NO-GO', runId: expect.any(String) });
    const run = state.runs.find((r: { id: string }) => r.id === state.automations[0].runId);
    expect(run).toMatchObject({ typeId: 't0', env: 'Staging', result: 'failed', passed: 18, failed: 2, bugs: 1, title: 'Smoke STG con Claude · NO-GO' });
    expect(run.notes).toContain('AVM-900');

    expect((await srv.call('DELETE', `/api/automation/${automation.id}`)).status).toBe(204);
    expect((await srv.call('POST', reportUrl.pathname, report)).status).toBe(404);
  });

  it('arma el comando de Claude Code con el skill', () => {
    expect(orchestratorCommand('AVM-7057')).toBe("claude '/avm-qa-orchestrator AVM-7057'");
    expect(() => orchestratorCommand("x'y")).toThrow();
    expect(regressionCommand('')).toBe("claude '/avm-qa-skills:avm-regression-runner'");
    expect(() => regressionCommand("#a b'c")).toThrow();
  });
});
