// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { extraIssues, fakeJira, startServer } from './helpers';

/** UI tests against the real API (only Jira is faked). */
describe('App', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: fakeJira,
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      assistant: async () => ({ reply: 'There is **1** pending smoke.\n- Launching it on STG', actions: [{ type: 'run_smoke', site: 'stg' }] }),
    });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});

    const realFetch = globalThis.fetch;
    // The UI uses relative paths; in tests they resolve against the temporary server.
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    // jsdom does not implement <dialog>.showModal().
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(cleanup);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  it('logs a test from a Jira ticket button', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /AVM-102/ }));
    const title = screen.getByLabelText('Título / qué se probó') as HTMLInputElement;
    expect(title.value).toBe('Vendor <import> & export');
    expect((screen.getByLabelText('Ticket (opcional)') as HTMLInputElement).value).toBe('AVM-102');

    fireEvent.change(screen.getByLabelText('Casos passed'), { target: { value: '4' } });
    fireEvent.submit(title.closest('form')!);

    await screen.findByText('Registro guardado');
    await waitFor(() => expect(screen.getByRole('button', { name: /AVM-102/ }).textContent).toContain('1 reg.'));

    const { body } = await srv.call('GET', '/api/state');
    expect(body.runs).toMatchObject([{ ticket: 'AVM-102', title: 'Vendor <import> & export', typeId: 't2', passed: 4, result: 'passed' }]);
  });

  it('suggests the result from the case counts until one is picked by hand', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /AVM-101/ }));
    const checked = () => screen.getByRole('radio', { checked: true }).textContent;

    fireEvent.change(screen.getByLabelText('Casos passed'), { target: { value: '5' } });
    expect(checked()).toBe('Passed');
    fireEvent.change(screen.getByLabelText('Casos failed'), { target: { value: '1' } });
    expect(checked()).toBe('Failed');

    fireEvent.click(screen.getByRole('radio', { name: 'Blocked' }));
    fireEvent.change(screen.getByLabelText('Casos failed'), { target: { value: '3' } });
    expect(checked()).toBe('Blocked');
  });

  it('shows the run in the list and deletes it with a double confirmation', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Registros' }));
    expect(screen.getByText('1 de 1 registros')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    fireEvent.click(screen.getByRole('button', { name: '¿Confirmar?' }));

    await screen.findByText('0 de 0 registros');
    expect((await srv.call('GET', '/api/state')).body.runs).toEqual([]);
  });

  it('adds a custom test type from the settings', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    fireEvent.change(screen.getByPlaceholderText(/Nuevo tipo de test/), { target: { value: 'Data migration' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar' })[0]!);

    await waitFor(async () => {
      const { body } = await srv.call('GET', '/api/state');
      expect(body.settings.types.at(-1)).toMatchObject({ name: 'Data migration', major: false });
    });
  });

  it('opens the QA report of an automation with its modules, steps and bugs', async () => {
    const { body: automation } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    await srv.call('POST', `/api/automation/${automation.id}/result`, {
      verdict: 'NO-GO', passed: 3, failed: 1, bugs: 1, minutes: 12, summary: 'Reports does not load',
      details: {
        modules: [
          { name: 'Login', status: 'passed', steps: [{ name: 'Log in as the QA user', status: 'passed' }] },
          { name: 'Reports', status: 'failed', minutes: 5, steps: [{ name: 'Open Fleet report', status: 'failed', notes: 'Error 500' }] },
        ],
        bugs: [{ title: 'Fleet report returns 500', severity: 'High', key: 'AVM-9001' }],
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver el reporte QA de Smoke STG' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reporte QA · Smoke STG' });
    expect(dialog.textContent).toContain('NO-GO');
    expect(dialog.textContent).toContain('12 min');
    expect(dialog.textContent).toContain('Reports does not load');
    expect(dialog.textContent).toContain('Open Fleet report');
    expect(dialog.textContent).toContain('Error 500');
    expect(dialog.textContent).toContain('AVM-9001 · Fleet report returns 500');

    // It also opens from its run in Runs ("Registros").
    fireEvent.click(screen.getAllByRole('button', { name: 'Cerrar' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Registros' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reporte' }));
    expect(await screen.findByRole('dialog', { name: 'Reporte QA · Smoke STG' })).toBeTruthy();
    await srv.call('DELETE', `/api/automation/${automation.id}`);
    await srv.call('DELETE', `/api/runs/${automation.runId}`);
  });

  it('switches the whole UI to English from the header', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'EN' }));
    await screen.findByRole('button', { name: 'Runs' });
    const spanish = /[áéíóúñ¿¡]|\b(de|del|los|las|registros?|ejecuci|ajustes|tickets por|hoy|sin)\b/i;
    const leftovers = (): string[] =>
      [...document.body.querySelectorAll('h1,h2,h3,button,label,th,p,span,option,legend,a')]
        .filter((el) => el.children.length === 0)
        .map((el) => (el.textContent ?? '').trim())
        // Test data (tickets, test types) is not app text.
        .filter((text) => text && spanish.test(text) && !/Vendor|Work order|Funcional|Exploratorio|Verificación|Integración|Seguridad|Accesibilidad|Migración|^Español$/.test(text));

    expect(screen.getByText('Tickets to test')).toBeTruthy();
    expect(leftovers()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(leftovers()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Types & settings' }));
    expect(leftovers()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /New run/ }));
    expect(await screen.findByLabelText('Title / what was tested')).toBeTruthy();
    expect(leftovers()).toEqual([]);

    // Server errors also arrive in English.
    expect((await srv.call('POST', '/api/smoke', { site: 'prod' })).body.error).toBe('That site does not exist: choose QA or STG');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    await screen.findByRole('button', { name: 'Registros' });
  });

  it('cycles between automatic, light and dark themes and saves it in the settings', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /^Tema: Automático/ });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.click(button);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    fireEvent.click(await screen.findByRole('button', { name: /^Tema: Claro/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect((await srv.call('GET', '/api/state')).body.settings.theme).toBe('dark');

    // Also from Types & settings ("Tipos y ajustes") → Appearance ("Apariencia").
    fireEvent.click(screen.getByRole('button', { name: 'Tipos y ajustes' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Apariencia' })).getByRole('button', { name: 'Automático' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    expect((await srv.call('GET', '/api/state')).body.settings.theme).toBe('system');
  });

  it('the assistant replies and only launches the action once confirmed', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Asistente/ }));
    const panel = screen.getByRole('complementary', { name: 'Asistente' });
    fireEvent.change(within(panel).getByLabelText('Pregunta o pide algo…'), { target: { value: 'What is pending?' } });
    fireEvent.keyDown(within(panel).getByLabelText('Pregunta o pide algo…'), { key: 'Enter' });

    expect(await within(panel).findByText('Launching it on STG')).toBeTruthy();
    expect(within(panel).getByText('1').tagName).toBe('B');
    const before = (await srv.call('GET', '/api/state')).body.automations.length;
    // Nothing launches without confirmation.
    expect((await srv.call('GET', '/api/state')).body.automations).toHaveLength(before);
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirmar' }));
    expect(await within(panel).findByText('Hecho')).toBeTruthy();
    const { body } = await srv.call('GET', '/api/state');
    expect(body.automations).toHaveLength(before + 1);
    expect(body.automations[0]).toMatchObject({ kind: 'smoke', target: 'STG' });
    await srv.call('POST', `/api/automation/${body.automations[0].id}/stop`, {});
  });

  it('refreshes tickets on its own when the window regains focus and announces new ones in On QA', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /AVM-101/ });
    extraIssues.push({ key: 'AVM-103', summary: 'New for QA', status: 'On Staging' });
    // The last load must be over a minute old for it to repeat.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    try {
      fireEvent.focus(window);
      expect(await screen.findByRole('button', { name: /AVM-103/ })).toBeTruthy();
      expect(await screen.findByText(/Nuevo ticket en On Staging: AVM-103/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
      extraIssues.length = 0;
    }
  });
});
