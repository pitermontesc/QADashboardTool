// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { useNow } from '../src/client/useNow';
import { fakeJira, startServer } from './helpers';

/**
 * Contract (behavior kept by the v1.17.1 lint clean-up): the settings forms follow data restored
 * from a copy, the Jira token box empties once the token is saved, a report whose translation
 * failed offers to retry, and a run that finishes while the app is open is announced.
 */
describe('Forms, translations and notices', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let translationFails = true;
  /** While set, a translation waits for it (to see the dialog while it is in progress). */
  let hold: Promise<void> | null = null;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: fakeJira,
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      translateReport: async (report) => {
        if (translationFails) throw new Error('translator down');
        await hold;
        return { ...report, summary: 'Todo pasa' };
      },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    await srv.reset();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const openSettings = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
  };

  it('restoring a copy brings its ticket link and sites back into the settings forms', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('PUT', '/api/settings', { ...state.settings, ticketBase: 'https://old.example.com/browse/' });
    const { body: made } = await srv.call('POST', '/api/backups', {});
    const qa = state.settings.qa;
    await srv.call('PUT', '/api/settings', {
      ...state.settings, ticketBase: 'https://new.example.com/browse/', qa: { ...qa, sites: qa.sites.map((s: { name: string }, i: number) => (i === 0 ? { ...s, name: 'Renamed' } : s)) },
    });

    await openSettings();
    const base = screen.getByLabelText(/^URL base/) as HTMLInputElement;
    expect(base.value).toBe('https://new.example.com/browse/');
    expect((screen.getByLabelText('Nombre 1') as HTMLInputElement).value).toBe('Renamed');

    const list = await screen.findByRole('list', { name: 'Copias automáticas' });
    const row = await waitFor(() => within(list).getAllByRole('listitem').find((r) => r.textContent!.includes('Manual'))!);
    fireEvent.click(within(row).getByRole('button', { name: /^Restaurar / }));
    fireEvent.click(within(row).getByRole('button', { name: 'Sí, restaurar' }));

    await waitFor(() => expect(base.value).toBe('https://old.example.com/browse/'));
    expect((screen.getByLabelText('Nombre 1') as HTMLInputElement).value).toBe(qa.sites[0].name);
    expect(made.created).toMatch(/-manual\.json$/);
  });

  it('once Jira is connected, the token box is emptied (the token is saved, not shown)', async () => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Sitio'), { target: { value: 'https://example.atlassian.net' } });
    fireEvent.change(screen.getByLabelText('Email de Atlassian'), { target: { value: 'qa@example.com' } });
    const token = screen.getByPlaceholderText('Pega aquí tu API token') as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'good' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar y cargar tickets' }));
    await waitFor(() => expect((screen.getByPlaceholderText(/guardado/) as HTMLInputElement).value).toBe(''));
    expect((await srv.call('GET', '/api/state')).body.jira.hasToken).toBe(true);
  });

  it('a report whose translation failed says so and translates on retry', async () => {
    const { body: state } = await srv.call('GET', '/api/state');
    await srv.call('PUT', '/api/settings', { ...state.settings, language: 'en' });
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'GO', summary: 'Everything passes' });
    await srv.call('PUT', '/api/settings', { ...state.settings, language: 'es' });
    translationFails = true;

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el reporte QA de Smoke STG' }));
    expect(await screen.findByText(/^No se pudo traducir el reporte/)).toBeTruthy();
    translationFails = false;
    let release = (): void => undefined;
    hold = new Promise((resolve) => (release = resolve));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    // The error goes as soon as the retry starts, not when it ends.
    expect(screen.queryByText(/^No se pudo traducir el reporte/)).toBeNull();
    release();
    expect(await screen.findAllByText('Todo pasa')).not.toHaveLength(0);
  });

  it('announces a run that finishes while the app is open', async () => {
    const { body: smoke } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<App />);
    await screen.findByRole('button', { name: 'Tipos y ajustes' });
    await srv.call('POST', `/api/automation/${smoke.id}/result`, { verdict: 'NO-GO', summary: 'Reports does not load' });
    act(() => vi.advanceTimersByTime(10_000)); // The app's refresh.
    expect(await screen.findByText('Smoke QA: NO-GO: Reports does not load')).toBeTruthy();
  });
});

describe('useNow', () => {
  afterEach(() => vi.useRealTimers());

  it('moves on by itself, so "5 min ago" and "today" stay current', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 23, 59, 50));
    const { result } = renderHook(() => useNow(30_000));
    const start = result.current;
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current - start).toBe(30_000);
    expect(new Date(result.current).getDate()).toBe(26);
  });
});
