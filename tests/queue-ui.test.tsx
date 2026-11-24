// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { startServer } from './helpers';

/**
 * Contract (v1.15.0, UI): "Validate all" lists the ready tickets per site in the order they would run
 * and queues only what the user confirms; a run asked for on a busy site says it is queued and shows
 * its place; the queue panel lets the user take a run out.
 */
const jira: typeof fetch = async () =>
  Response.json({
    issues: [
      ['AVM-11', 'On QA', 'Medium', '2026-11-01T10:00:00.000-0500'],
      ['AVM-12', 'On QA', 'Highest', '2026-11-20T10:00:00.000-0500'],
      ['AVM-13', 'On Staging', 'Low', '2026-11-05T10:00:00.000-0500'],
      ['AVM-14', 'Test', 'High', '2026-11-05T10:00:00.000-0500'],
    ].map(([key, status, priority, created]) => ({
      key,
      fields: { summary: `Summary ${key}`, status: { name: status }, issuetype: { name: 'Story' }, priority: { name: priority }, created },
    })),
  });

describe('Run queue in the app', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
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

  it('"Validate all" shows the order per site and queues only the confirmed tickets', async () => {
    await srv.call('POST', '/api/smoke', { site: 'qa' }); // QA is busy: its tickets wait.
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Validar todos (3)' }));
    const dialog = await screen.findByRole('dialog');
    // STG first, then QA by priority; AVM-14 ("Test") is not offered.
    const keys = within(dialog).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
    expect(keys).toEqual(['AVM-13', 'AVM-12', 'AVM-11']);
    expect(within(dialog).getByRole('region', { name: 'QA' }).textContent).toContain('El sitio está ocupado');
    expect(within(dialog).getByText(/Prioridad Highest/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'AVM-11' })); // Left out.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Encolar 2 tickets' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // AVM-13 started on STG at once; AVM-12 waits for QA.
    expect(await screen.findByText('1 empezó · 1 en la cola')).toBeTruthy();

    const { body } = await srv.call('GET', '/api/state');
    // STG was free: AVM-13 started. AVM-12 waits for the smoke on QA.
    expect(body.automations.filter((a: { finishedAt: number | null }) => a.finishedAt === null).map((a: { target: string }) => a.target).sort()).toEqual(['AVM-13', 'QA']);
    expect(body.queue.items.map((q: { target: string }) => q.target)).toEqual(['AVM-12']);
    // On its ticket card, and in the queue panel.
    const card = [...document.querySelectorAll<HTMLElement>('.tk')].find((el) => el.textContent!.includes('AVM-12'))!;
    expect(within(card).getByText('En cola · #1')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'QA' }).textContent).toContain('En curso: Smoke QA');
  });

  it('a smoke on a busy site says it is queued, shows its place, and can be taken out of the queue', async () => {
    await srv.call('POST', '/api/orchestrator/AVM-11', {}); // QA is busy.
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Smoke en QA/ }));
    expect(await screen.findByText(/Smoke QA en la cola de su sitio \(posición 1\)/)).toBeTruthy();
    expect(await screen.findByText('QA · En cola · #1')).toBeTruthy();
    expect(screen.getByTitle('Ver el progreso').textContent).toContain('1 en cola');

    fireEvent.click(screen.getByRole('button', { name: 'Quitar Smoke QA de la cola' }));
    await waitFor(() => expect(screen.queryByText('QA · En cola · #1')).toBeNull());
    expect((await srv.call('GET', '/api/state')).body.queue.items).toEqual([]);
  });

  it('when a whole batch is done, the app says how it went, after the last result', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Validar todos/ }));
    const dialog = await screen.findByRole('dialog');
    for (const box of within(dialog).getAllByRole('checkbox')) if ((box as HTMLInputElement).checked !== (box.getAttribute('aria-label') === 'AVM-13')) fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Encolar 1 ticket' }));
    await screen.findByText('1 empezó');

    const { body } = await srv.call('GET', '/api/state');
    const run = body.automations.find((a: { target: string; finishedAt: number | null }) => a.target === 'AVM-13' && a.finishedAt === null);
    await srv.call('POST', `/api/automation/${run.id}/result`, { verdict: 'PASSED', summary: 'All good' });
    vi.advanceTimersByTime(10_000); // The app's refresh.
    expect(await screen.findByText(/^Cola terminada: 1 PASSED · \d+ min$/)).toBeTruthy();
  });
});
