// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { extraIssues, fakeJira, startServer } from './helpers';

/** Prueba de la interfaz contra la API real (solo Jira está simulado). */
describe('App', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'good' });
    await srv.call('POST', '/api/jira/refresh', {});

    const realFetch = globalThis.fetch;
    // La interfaz usa rutas relativas; en la prueba se resuelven contra el servidor temporal.
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    // jsdom no implementa <dialog>.showModal().
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(cleanup);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  it('registra un test desde el botón de un ticket de Jira', async () => {
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

  it('sugiere el resultado según los casos hasta que se elige a mano', async () => {
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

  it('muestra el registro en la lista y lo borra con doble confirmación', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Registros' }));
    expect(screen.getByText('1 de 1 registros')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    fireEvent.click(screen.getByRole('button', { name: '¿Confirmar?' }));

    await screen.findByText('0 de 0 registros');
    expect((await srv.call('GET', '/api/state')).body.runs).toEqual([]);
  });

  it('agrega un tipo de test propio desde los ajustes', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    fireEvent.change(screen.getByPlaceholderText(/Nuevo tipo de test/), { target: { value: 'Migración de datos' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar' })[0]!);

    await waitFor(async () => {
      const { body } = await srv.call('GET', '/api/state');
      expect(body.settings.types.at(-1)).toMatchObject({ name: 'Migración de datos', major: false });
    });
  });

  it('abre el reporte QA de una ejecución con sus módulos, pasos y bugs', async () => {
    const { body: automation } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    await srv.call('POST', `/api/automation/${automation.id}/result`, {
      verdict: 'NO-GO', passed: 3, failed: 1, bugs: 1, minutes: 12, summary: 'Reports no carga',
      details: {
        modules: [
          { name: 'Login', status: 'passed', steps: [{ name: 'Entrar con usuario QA', status: 'passed' }] },
          { name: 'Reports', status: 'failed', minutes: 5, steps: [{ name: 'Abrir Fleet report', status: 'failed', notes: 'Error 500' }] },
        ],
        bugs: [{ title: 'Fleet report da 500', severity: 'High', key: 'AVM-9001' }],
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver el reporte QA de Smoke STG' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reporte QA · Smoke STG' });
    expect(dialog.textContent).toContain('NO-GO');
    expect(dialog.textContent).toContain('12 min');
    expect(dialog.textContent).toContain('Reports no carga');
    expect(dialog.textContent).toContain('Abrir Fleet report');
    expect(dialog.textContent).toContain('Error 500');
    expect(dialog.textContent).toContain('AVM-9001 · Fleet report da 500');

    // También se abre desde su registro en Registros.
    fireEvent.click(screen.getAllByRole('button', { name: 'Cerrar' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Registros' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reporte' }));
    expect(await screen.findByRole('dialog', { name: 'Reporte QA · Smoke STG' })).toBeTruthy();
    await srv.call('DELETE', `/api/automation/${automation.id}`);
    await srv.call('DELETE', `/api/runs/${automation.runId}`);
  });

  it('cambia toda la interfaz a inglés desde la cabecera', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'EN' }));
    await screen.findByRole('button', { name: 'Runs' });
    const spanish = /[áéíóúñ¿¡]|\b(de|del|los|las|registros?|ejecuci|ajustes|tickets por|hoy|sin)\b/i;
    const leftovers = (): string[] =>
      [...document.body.querySelectorAll('h1,h2,h3,button,label,th,p,span,option,legend,a')]
        .filter((el) => el.children.length === 0)
        .map((el) => (el.textContent ?? '').trim())
        // Datos de prueba (tickets, tipos de test) no son textos de la app.
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

    // Los errores del servidor también llegan en inglés.
    expect((await srv.call('POST', '/api/smoke', { site: 'prod' })).body.error).toBe('Choose the smoke site: QA or STG');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'ES' }));
    await screen.findByRole('button', { name: 'Registros' });
  });

  it('cambia entre tema automático, claro y oscuro y lo guarda en los ajustes', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /^Tema: Automático/ });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.click(button);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    fireEvent.click(await screen.findByRole('button', { name: /^Tema: Claro/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect((await srv.call('GET', '/api/state')).body.settings.theme).toBe('dark');

    // También desde Tipos y ajustes → Apariencia.
    fireEvent.click(screen.getByRole('button', { name: 'Tipos y ajustes' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Apariencia' })).getByRole('button', { name: 'Automático' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    expect((await srv.call('GET', '/api/state')).body.settings.theme).toBe('system');
  });

  it('actualiza los tickets solo al volver a la ventana y avisa de los nuevos en On QA', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /AVM-101/ });
    extraIssues.push({ key: 'AVM-103', summary: 'Nuevo para QA', status: 'On Staging' });
    // La última carga tiene que tener más de un minuto para que se repita.
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
