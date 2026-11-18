import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportTranslation } from '../src/shared/types';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { markdownToJira } from '../src/server/jiraMarkup';
import { Store } from '../src/server/store';
import { defaultSettings } from '../src/shared/defaults';
import { fakeJira, startServer } from './helpers';

/** Comentarios que recibió el Jira simulado. */
const comments: { key: string; body: string }[] = [];
const jira: typeof fetch = async (input, init) => {
  const match = /\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(new URL(String(input)).pathname);
  if (!match || init?.method !== 'POST') return fakeJira(input, init);
  comments.push({ key: decodeURIComponent(match[1]!), body: (JSON.parse(String(init.body)) as { body: string }).body });
  return Response.json({ id: '10042' }, { status: 201 });
};

/** Traductor simulado: antepone [EN] a cada texto, como haría Claude al traducir. */
const translations: ReportTranslation[] = [];
const fakeTranslate = async (report: ReportTranslation) => {
  translations.push(report);
  const tr = (text: string) => (text ? `[EN] ${text}` : text);
  return {
    summary: tr(report.summary),
    details: report.details && {
      ...report.details,
      notes: tr(report.details.notes),
      // Una traducción que cambia un estado o pierde pasos no debe romper el reporte.
      modules: report.details.modules.map((m) => ({ ...m, status: 'failed', name: tr(m.name), steps: m.steps.slice(0, 1).map((s) => ({ ...s, name: tr(s.name) })) })),
    },
  };
};

describe('Idioma de los datos y comentario de Jira', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const settings = async () => (await srv.call('GET', '/api/state')).body.settings;
  const setLanguage = async (language: 'es' | 'en') => srv.call('PUT', '/api/settings', { ...(await settings()), language });
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: jira,
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      translateReport: fakeTranslate,
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});
  });
  afterAll(() => srv.close());

  it('al pasar a inglés traduce tipos, títulos, notas y el reporte de Claude, y respeta lo editado', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    await srv.call('POST', `/api/automation/${smoke.id}/result`, {
      verdict: 'GO', passed: 2, summary: 'Todo pasa',
      details: { notes: 'Sin novedades', modules: [{ name: 'Login', status: 'passed', steps: [{ name: 'Entrar', status: 'passed' }, { name: 'Salir', status: 'skipped' }] }] },
    });
    const { body: edited } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${edited.id}/result`, { verdict: 'NO-GO', summary: 'Falla Reports' });
    const state0 = (await srv.call('GET', '/api/state')).body;
    const editedRun = state0.runs.find((r: { id: string }) => r.id === edited.runId);
    await srv.call('PUT', `/api/runs/${edited.runId}`, { ...editedRun, notes: 'Mi nota' });

    expect((await setLanguage('en')).body.types.map((t: { name: string }) => t.name)).toContain('Functional');
    await until(async () => (await srv.call('GET', '/api/state')).body.translating === 0);

    const { body: state } = await srv.call('GET', '/api/state');
    const auto = state.automations.find((a: { id: string }) => a.id === smoke.id);
    const run = state.runs.find((r: { id: string }) => r.id === smoke.runId);
    expect(auto.title).toBe('Smoke STG with Claude');
    expect(run).toMatchObject({ title: 'Smoke STG with Claude · GO', notes: 'Verdict GO.\n[EN] Todo pasa' });
    // Se traduce el texto; estados y pasos salen del original.
    expect(auto.translations.en.details.modules).toEqual([
      { name: '[EN] Login', status: 'passed', minutes: null, notes: '', steps: [{ name: '[EN] Entrar', status: 'passed', notes: '' }, { name: 'Salir', status: 'skipped', notes: '' }] },
    ]);
    expect(auto.translations.en.details.notes).toBe('[EN] Sin novedades');
    expect(auto.summary).toBe('Todo pasa');
    // El registro editado a mano conserva sus notas.
    expect(state.runs.find((r: { id: string }) => r.id === edited.runId).notes).toBe('Mi nota');

    // De vuelta en español no hace falta traducir: es el idioma original.
    const before = translations.length;
    await setLanguage('es');
    const back = (await srv.call('GET', '/api/state')).body;
    expect(back.runs.find((r: { id: string }) => r.id === smoke.runId)).toMatchObject({ title: 'Smoke STG con Claude · GO', notes: 'Veredicto GO.\nTodo pasa' });
    expect(back.settings.types.map((t: { name: string }) => t.name)).toContain('Funcional');
    expect(translations.length).toBe(before);
  });

  it('publica en Jira el comentario que Claude dejó listo, una sola vez', async () => {
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    expect(orch.title).toBe('Orquestador QA: Work order totals');
    await srv.call('POST', `/api/automation/${orch.id}/result`, {
      verdict: 'PASSED', summary: 'OK',
      details: { jiraComment: { key: 'avm-101', body: '**QA Verdict: PASSED**\n\n| # | Test |\n|---|---|\n| 1 | `GET /api/x` |' } },
    });
    const edited = '**QA Verdict: PASSED**\n\n- revisado';
    const { status, body } = await srv.call('POST', `/api/automation/${orch.id}/jira-comment`, { body: edited });
    expect(status).toBe(200);
    expect(comments).toEqual([{ key: 'AVM-101', body: '*QA Verdict: PASSED*\n\n* revisado' }]);
    expect(body.details.jiraComment).toEqual({
      key: 'AVM-101', body: edited, posted: true, url: 'https://example.atlassian.net/browse/AVM-101?focusedCommentId=10042', dismissed: false,
    });
    expect((await srv.call('POST', `/api/automation/${orch.id}/jira-comment`, {})).status).toBe(409);

    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'GO' });
    expect((await srv.call('POST', `/api/automation/${smoke.id}/jira-comment`, {})).status).toBe(404);
    expect(comments).toHaveLength(1);
  });

  it('descarta un comentario que ya se publicó por otro lado y lo puede recuperar', async () => {
    const { body: orch } = await srv.call('POST', '/api/orchestrator/AVM-101', {});
    await srv.call('POST', `/api/automation/${orch.id}/result`, { verdict: 'PASSED W/F', details: { jiraComment: { key: 'AVM-101', body: 'Borrador' } } });
    const url = `/api/automation/${orch.id}/jira-comment`;

    expect((await srv.call('POST', `${url}/dismiss`, {})).body.details.jiraComment).toMatchObject({ dismissed: true, posted: false });
    expect((await srv.call('POST', url, {})).status).toBe(409);
    expect((await srv.call('POST', `${url}/dismiss`, { dismissed: false })).body.details.jiraComment.dismissed).toBe(false);
    expect((await srv.call('POST', url, {})).status).toBe(200);
    expect((await srv.call('POST', `${url}/dismiss`, {})).status).toBe(409); // ya publicado
    expect(comments.at(-1)).toEqual({ key: 'AVM-101', body: 'Borrador' });
  });
});

describe('Datos guardados en el otro idioma', () => {
  it('al abrir la app se ponen en su idioma los textos que escribió la app', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
    const automation = {
      id: 'a1', kind: 'smoke', target: 'STG', title: 'Smoke STG con Claude', env: 'STG', startedAt: 1, finishedAt: 2, verdict: 'GO',
      summary: 'Todo pasa', link: '', details: null, runId: 'r1', pid: null, logFile: '',
    };
    const run = { id: 'r1', createdAt: 1, date: '2026-11-18', typeId: 't0', title: 'Smoke STG con Claude · GO', ticket: '', env: 'STG', result: 'passed',
      passed: 1, failed: null, blocked: null, bugs: null, minutes: 3, notes: 'Veredicto GO.\nTodo pasa' };
    writeFileSync(file, JSON.stringify({ version: 1, settings: { ...defaultSettings('es'), language: 'en' }, runs: [run], automations: [automation] }));

    const state = new Store(file).getState();
    expect(state.settings.types.find((t) => t.id === 't2')?.name).toBe('Functional');
    expect(state.runs[0]).toMatchObject({ title: 'Smoke STG with Claude · GO', notes: 'Verdict GO.\nTodo pasa' });
    // Se detecta el idioma del resumen para traducirlo después.
    expect(state.automations[0]).toMatchObject({ title: 'Smoke STG with Claude', lang: 'es', translations: {} });
  });
});

describe('markdownToJira', () => {
  it('convierte títulos, tablas, listas, negrita, código y links', () => {
    const md = [
      '### Results',
      '| # | Test | Result |',
      '|---|---|---|',
      '| 1 | Issue **103** | `GET /api/files/294` → 200 |',
      '',
      '- uno',
      '  - dos',
      '1. primero',
      'Ver [el ticket](https://example.atlassian.net/browse/AVM-1).',
      '```',
      'a **b**',
      '```',
    ].join('\n');
    expect(markdownToJira(md)).toBe(
      [
        'h3. Results',
        '||#||Test||Result||',
        '|1|Issue *103*|{{GET /api/files/294}} → 200|',
        '',
        '* uno',
        '** dos',
        '# primero',
        'Ver [el ticket|https://example.atlassian.net/browse/AVM-1].',
        '{code}',
        'a **b**',
        '{code}',
      ].join('\n'),
    );
  });
});
