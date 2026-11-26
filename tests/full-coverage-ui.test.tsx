// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import type { ClaudeJob } from '../src/server/claudeRunner';
import { startServer } from './helpers';

/**
 * Contract (v1.18.0, UI): a ticket ready for the orchestrator has a second button, "Completa", that
 * launches it with full coverage; the usual button still launches it without. The report of a
 * full-coverage run says so.
 */
const jira: typeof fetch = async () =>
  Response.json({
    issues: [
      ['AVM-21', 'On QA'],
      ['AVM-22', 'On Staging'],
      ['AVM-23', 'Test'],
    ].map(([key, status]) => ({
      key,
      fields: { summary: `Summary ${key}`, status: { name: status }, issuetype: { name: 'Story' }, priority: { name: 'Medium' }, created: '2026-11-01T10:00:00.000-0500' },
    })),
  });

describe('Full coverage button', () => {
  const jobs: ClaudeJob[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      fetchImpl: jira,
      launchClaude: async (job) => {
        jobs.push(job);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
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
    jobs.length = 0;
    await srv.reset();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const card = (key: string) => [...document.querySelectorAll<HTMLElement>('.tk')].find((el) => el.textContent!.includes(key))!;
  const running = async () => (await srv.call('GET', '/api/state')).body.automations.filter((a: { finishedAt: number | null }) => a.finishedAt === null);

  it('only ready tickets have it, and it launches the orchestrator with full coverage', async () => {
    render(<App />);
    const full = await screen.findByRole('button', { name: 'Ejecutar el orquestador QA en AVM-21 con cobertura completa' });
    expect(full.textContent).toBe('Completa');
    expect(full.getAttribute('title')).toContain('FULL COVERAGE');
    expect(within(card('AVM-22')).getByRole('button', { name: /AVM-22 con cobertura completa/ })).toBeTruthy();
    expect(within(card('AVM-23')).queryByRole('button', { name: /cobertura completa/ })).toBeNull();

    fireEvent.click(full);
    await waitFor(async () => expect((await running()).map((a: { target: string; fullCoverage: boolean }) => [a.target, a.fullCoverage])).toEqual([['AVM-21', true]]));
    expect(jobs.at(-1)!.prompt).toMatch(/^\/avm-qa-skills:avm-qa-orchestrator AVM-21 -- FULL COVERAGE:/);

    // The run's report says it has full coverage.
    fireEvent.click(await within(card('AVM-21')).findByTitle('Ver el progreso de la ejecución'));
    expect(await screen.findByText('Cobertura completa: con todos los agentes del orquestador')).toBeTruthy();
  });

  it('the usual button still launches it without full coverage, and its report has no tag', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /AVM-22 con cobertura completa/ }); // The tickets loaded.
    fireEvent.click(within(card('AVM-22')).getByRole('button', { name: 'Ejecutar orquestador QA' }));
    await waitFor(async () => expect((await running()).map((a: { target: string; fullCoverage: boolean }) => [a.target, a.fullCoverage])).toEqual([['AVM-22', false]]));
    expect(jobs.at(-1)!.prompt).not.toContain('FULL COVERAGE');
    fireEvent.click(await within(card('AVM-22')).findByTitle('Ver el progreso de la ejecución'));
    await screen.findByRole('dialog');
    expect(screen.queryByText(/^Cobertura completa/)).toBeNull();
  });
});
