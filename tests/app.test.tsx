// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { extraIssues, fakeJira, startServer } from './helpers';

/** Prueba de la interfaz contra la API real (solo Jira está simulado). */
describe('App', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    srv = await startServer({ fetchImpl: fakeJira });
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
