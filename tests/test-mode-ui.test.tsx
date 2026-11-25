// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { toYmd } from '../src/shared/dates';
import { startServer } from './helpers';

/**
 * Contract (v1.17.0, UI): the dashboard's numbers leave out runs in test mode and say how many it
 * left out; Runs lists them with a "Modo prueba" tag; the run form marks or unmarks a run by hand.
 */
describe('Runs in test mode (UI)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const today = toYmd(new Date());
  beforeAll(async () => {
    srv = await startServer({ launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    await srv.call('POST', '/api/runs', { date: today, typeId: 't0', title: 'Smoke STG', result: 'passed', passed: 20, failed: 0, blocked: 0, bugs: 0, minutes: 6 });
    await srv.call('POST', '/api/runs', {
      date: today, typeId: 't1', title: 'Regression rehearsal', result: 'failed', passed: 38, failed: 2, blocked: 112, bugs: 2, minutes: 41, testMode: true,
    });
  });
  afterEach(cleanup);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const kpi = (label: string) => screen.getByText(label).closest('.kpi') as HTMLElement;

  it('the dashboard counts only the real run, and says the rehearsal was left out', async () => {
    render(<App />);
    expect(await screen.findByText(/^Una ejecución en modo prueba no cuenta en estos números/)).toBeTruthy();
    expect(kpi('Pass rate').textContent).toContain('100%');
    expect(kpi('Pass rate').textContent).toContain('20 de 20 casos');
    expect(kpi('Casos ejecutados').textContent).toContain('0 failed · 0 blocked');
    expect(kpi('Bugs encontrados').textContent).toContain('0');
  });

  it('Runs lists the rehearsal with its tag, and the form unmarks it', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Registros' }));
    const rowOf = (title: string) => screen.getByText(title).closest('tr') as HTMLElement;
    expect(within(rowOf('Regression rehearsal')).getByText('Modo prueba')).toBeTruthy();
    expect(within(rowOf('Smoke STG')).queryByText('Modo prueba')).toBeNull();

    fireEvent.click(within(rowOf('Regression rehearsal')).getByRole('button', { name: 'Editar' }));
    const box = screen.getByRole('checkbox', { name: /^Ejecución de prueba/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.submit(box.closest('form')!);
    await waitFor(async () => {
      const { body } = await srv.call('GET', '/api/state');
      expect(body.runs.find((r: { title: string }) => r.title === 'Regression rehearsal').testMode).toBe(false);
    });
    await waitFor(() => expect(within(rowOf('Regression rehearsal')).queryByText('Modo prueba')).toBeNull());
  });
});
