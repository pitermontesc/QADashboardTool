// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { startServer } from './helpers';

/**
 * Contract (v1.14.1): what the user types or sees is never lost or repeated by something happening
 * elsewhere in the app (another save, a background refresh, a failed request), focus returns to where
 * it was after a dialog, and counts and statuses read naturally in the chosen language.
 */
describe('App state and feedback', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  /** Prompts the assistant received, and whether the next question fails. */
  const prompts: string[] = [];
  let assistantFails = false;
  /** While set, every /api/state response is held until the gate opens (a slow background refresh). */
  let gate: Promise<void> | null = null;
  /** While set, stopping a run fails as if the network dropped. */
  let stopFails = false;

  beforeAll(async () => {
    srv = await startServer({
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      assistant: async ({ prompt }) => {
        prompts.push(prompt);
        if (assistantFails) {
          assistantFails = false;
          throw new Error('Claude Code is busy');
        }
        return { reply: 'Nothing failed this week.', actions: [] };
      },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (stopFails && url.endsWith('/stop')) throw new TypeError('Failed to fetch');
      const res = await realFetch(new URL(url, srv.base), init);
      const held = gate;
      if (held && url === '/api/state') await held;
      return res;
    });
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    gate = null;
    stopFails = false;
    // Each test starts without runs in progress.
    for (const a of (await srv.call('GET', '/api/state')).body.automations) await srv.call('DELETE', `/api/automation/${a.id}`);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  it('an unsaved edit in Sites & skills survives saving another setting', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    fireEvent.change(screen.getByLabelText('Nombre 1'), { target: { value: 'QA nuevo' } });
    expect(screen.getByText('Hay cambios sin guardar.')).toBeTruthy();

    // The theme button saves the settings.
    fireEvent.click(screen.getByRole('button', { name: /^Tema:/ }));
    await waitFor(async () => expect((await srv.call('GET', '/api/state')).body.settings.theme).not.toBe('system'));

    expect((screen.getByLabelText('Nombre 1') as HTMLInputElement).value).toBe('QA nuevo');
    expect(screen.getByText('Hay cambios sin guardar.')).toBeTruthy();
    await srv.call('PUT', '/api/settings', { ...(await srv.call('GET', '/api/state')).body.settings, theme: 'system' });
  });

  it('retrying a failed question sends it to the assistant once', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Asistente/ }));
    const panel = screen.getByRole('complementary', { name: 'Asistente' });
    assistantFails = true;
    fireEvent.click(within(panel).getByRole('button', { name: '¿Qué falló esta semana?' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Reintentar' }));

    expect(await within(panel).findByText('Nothing failed this week.')).toBeTruthy();
    const asked = prompts.at(-1)!.match(/User: ¿Qué falló esta semana\?/g) ?? [];
    expect(asked).toHaveLength(1);
    // The question shows once in the conversation too.
    expect(within(panel).getAllByText('¿Qué falló esta semana?').filter((el) => el.closest('.assistant-msg'))).toHaveLength(1);
  });

  it('the header says a run is in progress in the chosen language', async () => {
    await srv.call('POST', '/api/smoke', { site: 'stg' });
    render(<App />);
    const indicator = await screen.findByTitle('Ver el progreso');
    expect(indicator.textContent).toMatch(/^En curso · Smoke STG · \d+ min$/);
  });

  it('when stopping a run fails, the Stop button can be used again', async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    render(<App />);
    fireEvent.click(await screen.findByTitle('Ver el progreso'));
    const dialog = await screen.findByRole('dialog');
    stopFails = true;
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Detener' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '¿Detener?' }));
      await screen.findByText('No se pudo conectar con la app local (¿sigue abierta?)');
    } finally {
      stopFails = false;
    }
    const stop = await within(dialog).findByRole('button', { name: 'Detener' });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect((await srv.call('GET', '/api/state')).body.automations.find((x: { id: string }) => x.id === a.id).finishedAt).toBeNull();
  });

  it('when a run reports just before Stop reaches the server, the report shows its result', async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    render(<App />);
    fireEvent.click(await screen.findByTitle('Ver el progreso'));
    const dialog = await screen.findByRole('dialog');
    // Claude reports just before the click reaches the server: stopping is refused (409).
    await srv.call('POST', `/api/automation/${a.id}/result`, { verdict: 'GO', summary: 'All good' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detener' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '¿Detener?' }));

    expect(await within(dialog).findByText('GO')).toBeTruthy();
    expect(within(dialog).queryByText('Deteniendo…')).toBeNull();
  });

  it('a background refresh that started before a delete does not bring the deleted run back', async () => {
    await srv.call('POST', '/api/smoke', { site: 'stg' }); // A run in progress turns the refresh on.
    const { body: run } = await srv.call('POST', '/api/runs', {
      date: '2026-11-20', typeId: 't1', title: 'Borrame', ticket: '', env: 'QA', result: 'passed',
      passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '',
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Registros' }));
    expect(await screen.findByText('Borrame')).toBeTruthy();

    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    vi.advanceTimersByTime(10_000); // The refresh asks the server, which still has the run.
    await new Promise((r) => setTimeout(r, 50));
    const row = screen.getByText('Borrame').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Borrar' }));
    fireEvent.click(within(row).getByRole('button', { name: '¿Confirmar?' }));
    await screen.findByText('Registro borrado');
    gate = null;
    release(); // The old answer arrives now.
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.queryByText('Borrame')).toBeNull();
    expect((await srv.call('GET', '/api/state')).body.runs.some((r: { id: string }) => r.id === run.id)).toBe(false);
  });

  it('closing a dialog returns focus to the button that opened it', async () => {
    render(<App />);
    const opener = await screen.findByRole('button', { name: 'Nuevo registro' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    (within(dialog).getByLabelText('Título / qué se probó') as HTMLInputElement).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('counts read naturally in the singular', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    const { body: state } = await srv.call('GET', '/api/state');
    const backup = {
      ...state.settings,
      runs: [{ id: 'r1', createdAt: 1, date: '2026-11-20', typeId: 't1', title: 'Solo', ticket: '', env: 'QA', result: 'passed', passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '' }],
    };
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Respaldo importado: 1 registro')).toBeTruthy();
  });
});
