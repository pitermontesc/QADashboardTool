import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { lastMessage, readActivity } from '../src/server/claudeRunner';
import { demoAppOptions, seedDemoData } from '../src/server/demo';
import { markdownToJira } from '../src/server/jiraMarkup';
import { Store } from '../src/server/store';
import type { ReportTranslation } from '../src/shared/types';
import { fakeJira, startServer } from './helpers';

/**
 * Casos borde: entradas inesperadas en la API, respuestas rotas de servicios
 * externos y carreras. Cada expectativa sale del contrato (guía, README, esquemas
 * o la instrucción que recibe Claude), no de lo que hoy hace el código.
 */

const run = (over: Record<string, unknown> = {}) => ({
  date: '2026-11-18', typeId: 't2', title: 'Caso', ticket: '', env: 'QA', result: 'passed',
  passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '', ...over,
});

describe('Registros y ajustes: entradas inesperadas', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => srv.close());

  it('rechaza fechas que no existen en el calendario', async () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-11-31']) {
      expect((await srv.call('POST', '/api/runs', run({ date }))).status, date).toBe(400);
    }
    expect((await srv.call('POST', '/api/runs', run({ date: '2028-02-29' }))).status).toBe(201);
  });

  it('rechaza casos negativos o con decimales, títulos en blanco y tipos que no existen', async () => {
    expect((await srv.call('POST', '/api/runs', run({ passed: -1 }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ failed: 1.5 }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ title: '   ' }))).status).toBe(400);
    expect((await srv.call('POST', '/api/runs', run({ typeId: 'no-existe' }))).status).toBe(400);
    const { body } = await srv.call('POST', '/api/runs', run());
    expect((await srv.call('PUT', `/api/runs/${body.id}`, run({ typeId: 'no-existe' }))).status).toBe(400);
  });

  it('no deja quitar un tipo con registros ni repetir ids de tipo', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const used = state.runs[0].typeId;
    const withoutUsed = { ...state.settings, types: state.settings.types.filter((t: { id: string }) => t.id !== used) };
    expect((await srv.call('PUT', '/api/settings', withoutUsed)).status).toBe(409);
    const dup = { ...state.settings, types: [...state.settings.types, { ...state.settings.types[0] }] };
    expect((await srv.call('PUT', '/api/settings', dup)).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings.types).toHaveLength(state.settings.types.length);
  });

  it('no importa un respaldo con registros de tipos que no existen', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    const backup = { ...state.settings, runs: [{ ...run({ typeId: 'fantasma' }), id: 'r1', createdAt: 1 }] };
    expect((await srv.call('POST', '/api/import', backup)).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.runs).toHaveLength(state.runs.length);
  });

  it('rechaza idioma o tema desconocidos sin tocar los ajustes guardados', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    expect((await srv.call('PUT', '/api/settings', { ...state.settings, theme: 'purple' })).status).toBe(400);
    expect((await srv.call('PUT', '/api/settings', { ...state.settings, language: 'fr' })).status).toBe(400);
    expect((await srv.call('GET', '/api/state')).body.settings).toMatchObject({ theme: 'system', language: 'es' });
  });

  it('responde 404 a registros o ejecuciones que no existen', async () => {
    expect((await srv.call('PUT', '/api/runs/nope', run())).status).toBe(404);
    expect((await srv.call('DELETE', '/api/runs/nope')).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/result', { verdict: 'GO' })).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/jira-comment', {})).status).toBe(404);
    expect((await srv.call('POST', '/api/automation/nope/translate', {})).status).toBe(404);
  });
});

describe('Resultado que reporta Claude', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());
  // No se puede lanzar dos veces lo mismo mientras corre: cada prueba detiene lo que dejó en curso.
  afterEach(async () => {
    for (const a of (await srv.call('GET', '/api/state')).body.automations) {
      if (a.finishedAt === null) await srv.call('POST', `/api/automation/${a.id}/stop`, {});
    }
  });

  it('solo acepta los veredictos de ese tipo de ejecución', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    expect((await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'PASSED' })).status).toBe(400);
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    expect((await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'GO' })).status).toBe(400);
    // Siguen esperando un resultado válido.
    expect((await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'no go' })).body.verdict).toBe('NO-GO');
    expect((await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'passed w/f' })).body.verdict).toBe('PASSED W/F');
  });

  it('no lanza dos veces lo mismo mientras corre (doble clic)', async () => {
    const [a, b] = await Promise.all([srv.call('POST', '/api/smoke', { site: 'stg' }), srv.call('POST', '/api/smoke', { site: 'stg' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const first = a.status === 200 ? a.body : b.body;
    // Otro sitio u otro ticket sí se pueden lanzar a la vez.
    expect((await srv.call('POST', '/api/smoke', { site: 'qa' })).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-101', {})).status).toBe(200);
    expect((await srv.call('POST', '/api/orchestrator/AVM-101', {})).status).toBe(409);
    // Al terminar, se puede volver a lanzar.
    await srv.call('POST', `/api/automation/${first.id}/result`, { verdict: 'GO' });
    expect((await srv.call('POST', '/api/smoke', { site: 'stg' })).status).toBe(200);
  });

  it('acepta textos largos recortándolos y números enviados como texto', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    const long = (n: number) => 'a'.repeat(n);
    const steps = Array.from({ length: 600 }, (_, i) => ({ name: `Paso ${i + 1}`, status: 'passed' }));
    const { status, body } = await srv.call('POST', url, {
      verdict: 'GO', passed: '7', failed: ' 2 ', blocked: '', bugs: 0, minutes: '12.4', summary: long(6000),
      details: { notes: long(9000), modules: [{ name: long(300), status: 'passed', minutes: '3', steps: [{ name: long(800), status: 'passed', notes: long(3000) }, ...steps] }] },
    });
    expect(status).toBe(200);
    expect(body.summary).toHaveLength(5000);
    expect(body.summary.endsWith('…')).toBe(true);
    expect(body.details.notes).toHaveLength(5000);
    const [module] = body.details.modules;
    expect(module.name).toHaveLength(200);
    expect(module.minutes).toBe(3);
    expect(module.steps).toHaveLength(500);
    expect(module.steps[0].name).toHaveLength(500);
    expect(module.steps[0].notes).toHaveLength(2000);
    const run = (await srv.call('GET', '/api/state')).body.runs.find((r: { id: string }) => r.id === smoke.runId);
    expect(run).toMatchObject({ passed: 7, failed: 2, blocked: null, bugs: 0, minutes: 12 });
    // Las notas del registro juntan veredicto y resumen: también se recortan.
    expect(run.notes.length).toBeLessThanOrEqual(5000);
    expect(run.notes.startsWith('Veredicto GO.')).toBe(true);
  });

  it('sigue rechazando números que no lo son o negativos', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    for (const passed of ['siete', '-1', -1, '7.5', true]) {
      expect((await srv.call('POST', url, { verdict: 'GO', passed })).status, String(passed)).toBe(400);
    }
    expect((await srv.call('POST', url, { verdict: 'GO', minutes: 'mucho' })).status).toBe(400);
    expect((await srv.call('POST', url, { verdict: 'GO', passed: '8' })).status).toBe(200);
  });

  it('no guarda links que no sean http(s) ni acepta el resultado dos veces', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    const url = `/api/automation/${smoke.id}/result`;
    expect((await srv.call('POST', url, { verdict: 'GO', link: 'javascript:alert(1)' })).status).toBe(400);
    const bug = { title: 'x', link: 'javascript:alert(1)' };
    expect((await srv.call('POST', url, { verdict: 'GO', details: { bugs: [bug] } })).status).toBe(400);
    expect((await srv.call('POST', url, { verdict: 'GO' })).status).toBe(200);
    expect((await srv.call('POST', url, { verdict: 'NO-GO' })).status).toBe(409);
    const { body } = await srv.call('GET', '/api/state');
    expect(body.automations.find((a: { id: string }) => a.id === smoke.id).verdict).toBe('GO');
  });
});

describe('Comentario de Jira: fallos y doble clic', () => {
  let posts = 0;
  let mode: 'ok' | 'slow' | 'auth' | 'down' = 'ok';
  const jira: typeof fetch = async (input, init) => {
    if (init?.method !== 'POST') return fakeJira(input, init);
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'auth') return new Response('{}', { status: 401 });
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 50));
    posts++;
    return Response.json({ id: String(posts) }, { status: 201 });
  };
  let srv: Awaited<ReturnType<typeof startServer>>;
  const draft = async () => {
    const { body: a } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'PASSED', details: { jiraComment: { key: 'AVM-101', body: 'QA OK' } } });
    return `/api/automation/${a.id}/jira-comment`;
  };
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());

  it('si Jira falla, el comentario sigue pendiente y se puede reintentar', async () => {
    const url = await draft();
    mode = 'auth';
    expect((await srv.call('POST', url, {})).status).toBe(502);
    mode = 'down';
    expect((await srv.call('POST', url, {})).status).toBe(502);
    mode = 'ok';
    const { status, body } = await srv.call('POST', url, {});
    expect(status).toBe(200);
    expect(body.details.jiraComment.posted).toBe(true);
    expect(posts).toBe(1);
  });

  it('dos clics a la vez publican una sola vez', async () => {
    const url = await draft();
    mode = 'slow';
    const before = posts;
    const results = await Promise.all([srv.call('POST', url, {}), srv.call('POST', url, {})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(posts - before).toBe(1);
    mode = 'ok';
  });

  it('sin Jira configurado no publica nada y lo deja pendiente', async () => {
    const url = await draft();
    await srv.call('PUT', '/api/jira/config', { site: '', email: '', board: '', jql: '', token: '' });
    const before = posts;
    expect((await srv.call('POST', url, {})).status).toBe(400);
    expect(posts).toBe(before);
    const id = url.split('/')[3];
    const { body } = await srv.call('GET', '/api/state');
    expect(body.automations.find((a: { id: string }) => a.id === id).details.jiraComment.posted).toBe(false);
  });
});

describe('Traducción con respuestas rotas', () => {
  let answer: () => unknown = () => ({});
  let calls = 0;
  let srv: Awaited<ReturnType<typeof startServer>>;
  const original = {
    notes: 'Notas', modules: [{ name: 'Login', status: 'failed', steps: [{ name: 'Entrar', status: 'failed', notes: 'Error 500' }] }],
    bugs: [{ title: 'Login da 500', severity: 'High', key: 'AVM-1' }],
  };
  beforeAll(async () => {
    srv = await startServer({
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      translateReport: async (_report: ReportTranslation) => {
        calls++;
        return answer();
      },
    });
  });
  afterAll(() => srv.close());
  const finished = async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'NO-GO', summary: 'Falla login', details: original });
    return a.id as string;
  };

  it('una respuesta que no es un reporte deja el original y no se reintenta sola', async () => {
    const id = await finished();
    answer = () => 'no soy JSON';
    expect((await srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' })).status).toBe(502);
    const before = calls;
    const settings = (await srv.call('GET', '/api/state')).body.settings;
    await srv.call('PUT', '/api/settings', { ...settings, language: 'en' });
    await srv.call('PUT', '/api/settings', { ...settings, language: 'es' });
    // El cambio de idioma no vuelve a intentar la que falló.
    expect(calls).toBe(before);
    const a = (await srv.call('GET', '/api/state')).body.automations.find((x: { id: string }) => x.id === id);
    expect(a.translations).toEqual({});
    expect(a.summary).toBe('Falla login');
  });

  it('una traducción que cambia estados, claves o links no los cambia en el reporte', async () => {
    const id = await finished();
    answer = () => ({
      summary: 'Login fails',
      details: {
        notes: 'Notes', build: '',
        modules: [{ name: 'Sign in', status: 'passed', minutes: 99, steps: [{ name: 'Enter', status: 'passed', notes: 'HTTP 500' }, { name: 'Extra', status: 'passed' }] }, { name: 'Ghost', status: 'passed' }],
        bugs: [{ title: 'Login returns 500', severity: 'Low', key: 'AVM-999', link: 'https://evil.example' }],
      },
    });
    const { body } = await srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' });
    expect(body.translations.en.details.modules).toEqual([
      { name: 'Sign in', status: 'failed', minutes: null, notes: '', steps: [{ name: 'Enter', status: 'failed', notes: 'HTTP 500' }] },
    ]);
    expect(body.translations.en.details.bugs).toEqual([{ title: 'Login returns 500', severity: 'High', key: 'AVM-1', link: '', module: '' }]);
  });

  it('borrar la ejecución mientras se traduce no rompe nada', async () => {
    const id = await finished();
    let release: (v: unknown) => void = () => undefined;
    answer = () => new Promise((r) => (release = r));
    const before = calls;
    const pending = srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' });
    // Espera a que la traducción esté en curso (el traductor ya recibió el reporte).
    while (calls === before) await new Promise((r) => setTimeout(r, 1));
    expect((await srv.call('DELETE', `/api/automation/${id}`)).status).toBe(204);
    release({ summary: 'Login fails', details: null });
    expect((await pending).status).toBe(200);
    expect((await srv.call('GET', '/api/state')).body.automations.some((a: { id: string }) => a.id === id)).toBe(false);
  });
});

describe('Log de Claude: archivos ausentes o dañados', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-log-'));

  it('un log que no existe no da actividad ni mensaje', () => {
    expect(readActivity(path.join(dir, 'no-existe.jsonl'))).toEqual([]);
    expect(lastMessage(path.join(dir, 'no-existe.jsonl'))).toBe('');
  });

  it('las líneas dañadas aparecen como error y no ocultan el resto', () => {
    const file = path.join(dir, 'roto.jsonl');
    writeFileSync(file, ['{"type":"system","subtype":"init"}', '{roto', '', '{"type":"assistant","message":{"content":"texto suelto"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Listo"}]}}'].join('\n'));
    expect(readActivity(file)).toEqual([{ kind: 'start', text: '' }, { kind: 'error', text: '{roto' }, { kind: 'text', text: 'Listo' }]);
    expect(lastMessage(file)).toBe('Listo');
  });

  it('en un log enorme solo lee el final y no muestra la primera línea cortada', () => {
    const file = path.join(dir, 'grande.jsonl');
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
    writeFileSync(file, `${Array.from({ length: 700 }, () => filler).join('\n')}\n${JSON.stringify({ type: 'result', result: 'Fin' })}\n`);
    const items = readActivity(file, 1000);
    expect(items.every((i) => i.kind !== 'error')).toBe(true);
    expect(items.at(-1)).toEqual({ kind: 'result', text: 'Fin' });
  });
});

describe('Demo: casos borde', () => {
  it('detener una ejecución simulada la deja BLOCKED y la simulación no reporta después', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'qa-demo-')), 'data');
    seedDemoData(dir, 'es');
    const server = createApp(new Store(path.join(dir, 'qa-tests.json')), demoAppOptions(dir, 5)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) =>
      (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
    try {
      const launched = await call('POST', '/api/smoke', { site: 'qa' });
      await call('POST', `/api/automation/${launched.id}/stop`);
      await new Promise((r) => setTimeout(r, 150));
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.automations.find((a: { id: string }) => a.id === launched.id)).toMatchObject({ verdict: 'BLOCKED' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('los datos de ejemplo nunca tienen fechas futuras, aunque se abra de madrugada', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'qa-demo-')), 'data');
    const now = new Date(2026, 10, 19, 0, 40).getTime();
    seedDemoData(dir, 'es', now);
    const state = new Store(path.join(dir, 'qa-tests.json')).getState();
    for (const r of state.runs) expect(r.createdAt, r.title).toBeLessThanOrEqual(now);
    for (const a of state.automations) expect(a.finishedAt!, a.title).toBeLessThanOrEqual(now);
  });
});

describe('markdownToJira: entradas raras', () => {
  it('acepta finales de línea de Windows', () => {
    expect(markdownToJira('### Hola\r\n- uno\r\n')).toBe('h3. Hola\n* uno\n');
  });

  it('un bloque de código sin cerrar conserva su texto', () => {
    expect(markdownToJira('Antes\n```\nlinea 1\nlinea 2')).toBe('Antes\n{code}\nlinea 1\nlinea 2\n{code}');
  });

  it('la cursiva de Markdown pasa a la de Jira', () => {
    expect(markdownToJira('Ver *nota* y **negrita**')).toBe('Ver _nota_ y *negrita*');
  });

  it('un asterisco suelto no se vuelve negrita en Jira', () => {
    // En wiki markup *a* es negrita: «2*3*4» de Markdown tiene que seguir leyéndose igual.
    expect(markdownToJira('Total 2*3*4 = 24')).toBe('Total 2\\*3\\*4 = 24');
  });
});
