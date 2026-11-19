import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantInput } from '../src/server/assistant';
import { demoAssistant } from '../src/server/demo';
import { HttpError } from '../src/server/errors';
import { fakeJira, startServer } from './helpers';

describe('QA assistant', () => {
  const asked: AssistantInput[] = [];
  let answer: () => unknown = () => ({ reply: 'Hello', actions: [] });
  const launched: string[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: fakeJira,
      launchClaude: async (job) => {
        launched.push(job.prompt);
        return { pid: null, logFile: '', stop: () => undefined };
      },
      assistant: async (input) => {
        asked.push(input);
        return answer();
      },
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'secret@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
    await srv.call('POST', '/api/runs', { date: '2026-11-18', typeId: 't2', title: 'PO PDF without address', ticket: 'AVM-101', env: 'QA', result: 'failed', failed: 1, bugs: 1 });
  });
  afterAll(() => srv.close());
  const ask = (text: string) => srv.call('POST', '/api/assistant', { messages: [{ role: 'user', text }] });

  it("passes the app's data to Claude, but never the Jira token or email", async () => {
    await ask('What failed?');
    const input = asked.at(-1)!;
    expect(input.prompt).toContain('PO PDF without address');
    expect(input.prompt).toContain('AVM-101');
    expect(input.prompt).toContain('User: What failed?');
    // The app is in Spanish (the default), so the assistant must reply in Spanish.
    expect(input.system).toContain('Reply in Spanish');
    expect(`${input.prompt}${input.system}`).not.toMatch(/good|secret@example\.com/);
  });

  it('only returns actions the app can perform, and performs none on its own', async () => {
    answer = () => ({
      reply: 'I propose this',
      actions: [
        { type: 'run_smoke', site: 'stg' },
        { type: 'run_smoke', site: 'prod' },
        { type: 'run_orchestrator', key: 'avm-101' },
        { type: 'run_orchestrator', key: 'AVM-102' }, // in "Test": cannot be orchestrated
        { type: 'run_orchestrator', key: 'AVM-999' },
        { type: 'create_run', run: { date: '2026-11-19', typeId: 't2', title: 'Re-test PDF', result: 'passed' } },
        { type: 'create_run', run: { date: '2026-11-19', typeId: 'missing', title: 'X', result: 'passed' } },
        { type: 'open_report', automationId: 'missing' },
        { type: 'post_jira_comment', automationId: 'missing' },
        { type: 'delete_everything' },
      ],
    });
    const { status, body } = await ask('Do things');
    expect(status).toBe(200);
    expect(body.reply).toBe('I propose this');
    expect(body.actions.map((a: { type: string }) => a.type)).toEqual(['run_smoke', 'run_orchestrator', 'create_run']);
    expect(body.actions[1]).toEqual({ type: 'run_orchestrator', key: 'AVM-101' });
    expect(launched).toEqual([]);
    expect((await srv.call('GET', '/api/state')).body.runs).toHaveLength(1);
  });

  it('only proposes posting a Jira comment that is still pending', async () => {
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'PASSED', details: { jiraComment: { key: 'AVM-101', body: 'QA OK' } } });
    answer = () => ({ reply: 'Posting', actions: [{ type: 'post_jira_comment', automationId: orch.id }, { type: 'open_report', automationId: orch.id }] });
    expect((await ask('Post the comment')).body.actions).toHaveLength(2);
    await srv.call('POST', `/api/automation/${orch.id}/jira-comment/dismiss`, {});
    expect((await ask('Post the comment')).body.actions).toEqual([{ type: 'open_report', automationId: orch.id }]);
  });

  it('shows plain text if Claude does not answer in JSON, and fails clearly if it answers nothing', async () => {
    answer = () => 'There is 1 failed test run.';
    expect((await ask('What failed?')).body).toEqual({ reply: 'There is 1 failed test run.', actions: [] });
    answer = () => ({ reply: '', actions: [] });
    const empty = await ask('What failed?');
    expect(empty.status).toBe(502);
    expect(empty.body.error).toBe('El asistente no pudo responder: respuesta vacía');
    answer = () => {
      throw new HttpError(502, 'The assistant could not answer: no session');
    };
    const failed = await ask('What failed?');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('El asistente no pudo responder: no session');
  });

  it('rejects conversations that are empty, too long or do not end with the user', async () => {
    expect((await srv.call('POST', '/api/assistant', { messages: [] })).status).toBe(400);
    expect((await srv.call('POST', '/api/assistant', { messages: [{ role: 'user', text: '   ' }] })).status).toBe(400);
    expect((await srv.call('POST', '/api/assistant', { messages: [{ role: 'assistant', text: 'Hello' }] })).status).toBe(400);
    const long = Array.from({ length: 41 }, () => ({ role: 'user', text: 'x' }));
    expect((await srv.call('POST', '/api/assistant', { messages: long })).status).toBe(400);
  });
});

describe("The demo's simulated assistant", () => {
  const context = {
    today: '2026-11-19', language: 'es' as const, testTypes: [], environments: [], totalRuns: 1,
    sites: [{ id: 'qa', name: 'QA', url: 'https://qa.example', env: 'QA', jiraStatus: 'On QA' }, { id: 'stg', name: 'STG', url: 'https://stg.example', env: 'STG', jiraStatus: 'On Staging' }],
    regressionSite: 'stg',
    jira: { connected: true, tickets: [{ key: 'AVM-7061', summary: 'Totals', status: 'On QA', type: 'Story', canRunOrchestrator: true }] },
    runs: [{ date: '2026-11-18', type: 'Funcional', title: 'PDF without address', ticket: 'AVM-7068', env: 'QA', result: 'failed' as const, passed: 3, failed: 1, blocked: 0, bugs: 1, minutes: 25, notes: '' }],
    claudeRuns: [{
      automationId: 'a1', kind: 'orchestrator' as const, target: 'AVM-7057', env: 'QA', status: 'finished', verdict: 'PASSED W/F' as const,
      startedAt: '', finishedAt: '', summary: 'Passes with one blocker', modules: [], bugs: [], jiraComment: { ticket: 'AVM-7057', state: 'pending' },
    }],
  };
  const reply = (text: string) => demoAssistant({ system: '', prompt: '', schema: {}, context, messages: [{ role: 'user', text }], lang: 'es' }) as Promise<{ reply: string; actions: unknown[] }>;

  it('recognizes typical requests (in Spanish) and proposes the matching action', async () => {
    expect((await reply('Lanza el smoke en QA')).actions).toEqual([{ type: 'run_smoke', site: 'qa' }]);
    expect((await reply('corre un smoke')).actions).toEqual([{ type: 'run_smoke', site: 'stg' }]);
    expect((await reply('valida AVM-7061 con el orquestador')).actions).toEqual([{ type: 'run_orchestrator', key: 'AVM-7061' }]);
    expect((await reply('publica el comentario de Jira')).actions).toEqual([{ type: 'post_jira_comment', automationId: 'a1' }]);
    expect((await reply('¿Qué falló esta semana?')).reply).toContain('PDF without address');
    expect((await reply('Resume el último reporte')).actions).toEqual([{ type: 'open_report', automationId: 'a1' }]);
    expect((await reply('hola')).actions).toEqual([]);
  });
});
