// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { startServer } from './helpers';

/**
 * Contract (v1.16.0, UI): Types & settings → Data backup lists the automatic copies, newest first;
 * restoring one asks first, then brings its runs back and says so; it is not offered while a run is
 * in progress. "Copy the last lines" puts the end of the app log on the clipboard.
 */
const RUN = { date: '2026-11-17', typeId: 't0', title: 'Smoke release', result: 'passed', passed: 20, failed: 0 };

describe('Automatic copies in Settings', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const copied: string[] = [];
  beforeAll(async () => {
    srv = await startServer({ launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
  });
  afterEach(async () => {
    cleanup();
    await srv.reset();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const openSettings = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    return screen.findByRole('list', { name: 'Copias automáticas' });
  };

  it('restores a copy after asking, and the app shows its runs', async () => {
    await srv.call('POST', '/api/runs', { ...RUN, title: 'From the copy' });
    const { body: made } = await srv.call('POST', '/api/backups', {});
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('POST', '/api/import', { ...state.settings, runs: [] });

    const list = await openSettings();
    // The import kept a copy of the data it replaced (and, as the day's first change since, so did the daily copy).
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(list).getAllByRole('listitem');
    const row = (reason: string) => rows.find((r) => r.textContent!.includes(reason))!;
    expect(row('Antes de importar').textContent).toContain('1 registro · 0 reportes');
    // Newest first: the manual copy is the oldest.
    const manual = rows.at(-1)!;
    expect(manual.textContent).toContain('Manual');
    expect(manual.textContent).toContain('1 registro · 0 reportes');

    fireEvent.click(within(manual).getByRole('button', { name: /^Restaurar / }));
    // Nothing changes until the user confirms.
    expect((await srv.call('GET', '/api/state')).body.runs).toEqual([]);
    fireEvent.click(within(manual).getByRole('button', { name: 'Sí, restaurar' }));

    expect(await screen.findByText(/^Datos restaurados de la copia del /)).toBeTruthy();
    expect((await srv.call('GET', '/api/state')).body.runs.map((r: { title: string }) => r.title)).toEqual(['From the copy']);
    // The copy of what was replaced shows up too.
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain('Antes de restaurar'));
    expect(made.created).toMatch(/-manual\.json$/);
  });

  it('does not offer to restore while a run is in progress', async () => {
    await srv.call('POST', '/api/backups', {});
    await srv.call('POST', '/api/smoke', { site: 'qa' });
    const list = await openSettings();
    await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0));
    for (const button of within(list).getAllByRole('button', { name: /^Restaurar / })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Para restaurar, espera a que terminen/)).toBeTruthy();
  });

  it('copies the last lines of the app log', async () => {
    await openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar las últimas líneas' }));
    expect(await screen.findByText(/^Log copiado \(\d+ líneas\)$/)).toBeTruthy();
    expect(copied.at(-1)).toMatch(/claude\.start .*kind=smoke target=QA/);
  });
});
