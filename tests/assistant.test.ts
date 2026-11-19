import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantInput } from '../src/server/assistant';
import { demoAssistant } from '../src/server/demo';
import { HttpError } from '../src/server/errors';
import { fakeJira, startServer } from './helpers';

describe('Asistente de QA', () => {
  const asked: AssistantInput[] = [];
  let answer: () => unknown = () => ({ reply: 'Hola', actions: [] });
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
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'secreto@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
    await srv.call('POST', '/api/runs', { date: '2026-11-18', typeId: 't2', title: 'PDF del PO sin dirección', ticket: 'AVM-101', env: 'QA', result: 'failed', failed: 1, bugs: 1 });
  });
  afterAll(() => srv.close());
  const ask = (text: string) => srv.call('POST', '/api/assistant', { messages: [{ role: 'user', text }] });

  it('le pasa a Claude los datos de la app, pero nunca el token ni el email de Jira', async () => {
    await ask('¿Qué falló?');
    const input = asked.at(-1)!;
    expect(input.prompt).toContain('PDF del PO sin dirección');
    expect(input.prompt).toContain('AVM-101');
    expect(input.prompt).toContain('Usuario: ¿Qué falló?');
    expect(input.system).toContain('Responde en español');
    expect(`${input.prompt}${input.system}`).not.toMatch(/good|secreto@example\.com/);
  });

  it('solo devuelve acciones que la app puede hacer, y no hace ninguna por su cuenta', async () => {
    answer = () => ({
      reply: 'Propongo esto',
      actions: [
        { type: 'run_smoke', site: 'stg' },
        { type: 'run_smoke', site: 'prod' },
        { type: 'run_orchestrator', key: 'avm-101' },
        { type: 'run_orchestrator', key: 'AVM-102' }, // en «Test»: no se puede orquestar
        { type: 'run_orchestrator', key: 'AVM-999' },
        { type: 'create_run', run: { date: '2026-11-19', typeId: 't2', title: 'Re-test PDF', result: 'passed' } },
        { type: 'create_run', run: { date: '2026-11-19', typeId: 'no-existe', title: 'X', result: 'passed' } },
        { type: 'open_report', automationId: 'no-existe' },
        { type: 'post_jira_comment', automationId: 'no-existe' },
        { type: 'borrar_todo' },
      ],
    });
    const { status, body } = await ask('Haz cosas');
    expect(status).toBe(200);
    expect(body.reply).toBe('Propongo esto');
    expect(body.actions.map((a: { type: string }) => a.type)).toEqual(['run_smoke', 'run_orchestrator', 'create_run']);
    expect(body.actions[1]).toEqual({ type: 'run_orchestrator', key: 'AVM-101' });
    expect(launched).toEqual([]);
    expect((await srv.call('GET', '/api/state')).body.runs).toHaveLength(1);
  });

  it('propone publicar solo un comentario de Jira que sigue pendiente', async () => {
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'PASSED', details: { jiraComment: { key: 'AVM-101', body: 'QA OK' } } });
    answer = () => ({ reply: 'Publico', actions: [{ type: 'post_jira_comment', automationId: orch.id }, { type: 'open_report', automationId: orch.id }] });
    expect((await ask('Publica el comentario')).body.actions).toHaveLength(2);
    await srv.call('POST', `/api/automation/${orch.id}/jira-comment/dismiss`, {});
    expect((await ask('Publica el comentario')).body.actions).toEqual([{ type: 'open_report', automationId: orch.id }]);
  });

  it('muestra texto suelto si Claude no responde en JSON, y falla claro si no responde nada', async () => {
    answer = () => 'Hay 1 registro fallido.';
    expect((await ask('¿Qué falló?')).body).toEqual({ reply: 'Hay 1 registro fallido.', actions: [] });
    answer = () => ({ reply: '', actions: [] });
    expect((await ask('¿Qué falló?')).status).toBe(502);
    answer = () => {
      throw new HttpError(502, 'El asistente no pudo responder: sin sesión');
    };
    const failed = await ask('¿Qué falló?');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('sin sesión');
  });

  it('rechaza conversaciones vacías, demasiado largas o que no terminan en el usuario', async () => {
    expect((await srv.call('POST', '/api/assistant', { messages: [] })).status).toBe(400);
    expect((await srv.call('POST', '/api/assistant', { messages: [{ role: 'user', text: '   ' }] })).status).toBe(400);
    expect((await srv.call('POST', '/api/assistant', { messages: [{ role: 'assistant', text: 'Hola' }] })).status).toBe(400);
    const long = Array.from({ length: 41 }, () => ({ role: 'user', text: 'x' }));
    expect((await srv.call('POST', '/api/assistant', { messages: long })).status).toBe(400);
  });
});

describe('Asistente simulado de la demo', () => {
  const context = {
    today: '2026-11-19', language: 'es' as const, testTypes: [], environments: [], totalRuns: 1,
    sites: [{ id: 'qa', name: 'QA', url: 'https://qa.example', env: 'QA', jiraStatus: 'On QA' }, { id: 'stg', name: 'STG', url: 'https://stg.example', env: 'STG', jiraStatus: 'On Staging' }],
    regressionSite: 'stg',
    jira: { connected: true, tickets: [{ key: 'AVM-7061', summary: 'Totals', status: 'On QA', type: 'Story', canRunOrchestrator: true }] },
    runs: [{ date: '2026-11-18', type: 'Funcional', title: 'PDF sin dirección', ticket: 'AVM-7068', env: 'QA', result: 'failed' as const, passed: 3, failed: 1, blocked: 0, bugs: 1, minutes: 25, notes: '' }],
    claudeRuns: [{
      automationId: 'a1', kind: 'orchestrator' as const, target: 'AVM-7057', env: 'QA', status: 'finished', verdict: 'PASSED W/F' as const,
      startedAt: '', finishedAt: '', summary: 'Pasa con un bloqueo', modules: [], bugs: [], jiraComment: { ticket: 'AVM-7057', state: 'pending' },
    }],
  };
  const reply = (text: string) => demoAssistant({ system: '', prompt: '', schema: {}, context, messages: [{ role: 'user', text }], lang: 'es' }) as Promise<{ reply: string; actions: unknown[] }>;

  it('reconoce las peticiones típicas y propone la acción correspondiente', async () => {
    expect((await reply('Lanza el smoke en QA')).actions).toEqual([{ type: 'run_smoke', site: 'qa' }]);
    expect((await reply('corre un smoke')).actions).toEqual([{ type: 'run_smoke', site: 'stg' }]);
    expect((await reply('valida AVM-7061 con el orquestador')).actions).toEqual([{ type: 'run_orchestrator', key: 'AVM-7061' }]);
    expect((await reply('publica el comentario de Jira')).actions).toEqual([{ type: 'post_jira_comment', automationId: 'a1' }]);
    expect((await reply('¿Qué falló esta semana?')).reply).toContain('PDF sin dirección');
    expect((await reply('Resume el último reporte')).actions).toEqual([{ type: 'open_report', automationId: 'a1' }]);
    expect((await reply('hola')).actions).toEqual([]);
  });
});
