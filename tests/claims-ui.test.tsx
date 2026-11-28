// @vitest-environment jsdom
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { buildTeamFile, writeTeamFile } from '../src/server/team';
import type { Automation } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.23.0, UI): a ticket card says when a teammate is validating it, has it queued or
 * validated it on that site; launching one a teammate is running or has queued takes a second click
 * ("Run anyway?"). "Validate all" leaves those tickets unchecked and says who has them.
 */
const jira: typeof fetch = async () =>
  Response.json({
    issues: [
      ['AVM-11', 'On QA'],
      ['AVM-12', 'On QA'],
      ['AVM-13', 'On Staging'],
      ['AVM-15', 'On QA'],
    ].map(([key, status]) => ({
      key,
      fields: { summary: `Summary ${key}`, status: { name: status }, issuetype: { name: 'Story' }, priority: { name: 'Medium' }, created: '2026-11-01T10:00:00.000-0500' },
    })),
  });

const orch = (target: string, extra: Partial<Automation>): Automation => ({
  id: `run-${target}`, kind: 'orchestrator', target, title: `QA orchestrator · ${target}`, env: 'QA', startedAt: Date.now() - 12 * 60_000, finishedAt: null, verdict: null,
  summary: '', link: '', runId: null, pid: null, logFile: '', lang: 'es', translations: {}, dryRun: false, fullCoverage: false, site: 'qa', ticketType: 'Story',
  queued: null, details: null, ...extra,
});

describe('Teammates\' tickets in the app', () => {
  const folder = path.join(mkdtempSync(path.join(tmpdir(), 'qa-claims-ui-')), 'QA Team');
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
    await srv.call('PUT', '/api/team', { folder, name: 'Piter' });
    const now = Date.now();
    writeTeamFile(folder, buildTeamFile({ id: 'luis-0000-1111', name: 'Luis Torres' }, '1.23.0', [], [], [orch('AVM-12', {})], now, [
      { id: 'q1', kind: 'orchestrator', target: 'AVM-15', site: 'qa', dryRun: false, fullCoverage: false, addedAt: now, batch: 'b', retries: 0 },
    ]));
    writeTeamFile(folder, buildTeamFile({ id: 'marta-0000-2222', name: 'Marta Gómez' }, '1.23.0', [], [], [
      orch('AVM-13', { site: 'stg', env: 'STG', finishedAt: Date.parse('2026-11-25T14:00:00'), verdict: 'PASSED', summary: 'ok' }),
    ]));
    await srv.call('GET', '/api/team');
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(async () => {
    cleanup();
    await srv.reset();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const card = async (key: string): Promise<HTMLElement> => {
    await screen.findByText(key);
    return [...document.querySelectorAll<HTMLElement>('.tk')].find((el) => el.querySelector('.tk-key')?.textContent === key)!;
  };
  const running = async (): Promise<string[]> =>
    (await srv.call('GET', '/api/state')).body.automations.filter((a: Automation) => a.finishedAt === null).map((a: Automation) => a.target);

  it('a card says who is on the ticket, and launching one a teammate is running takes a second click', async () => {
    render(<App />);
    const luis = await card('AVM-12');
    expect(within(luis).getByText('Luis Torres lo está validando · 12 min')).toBeTruthy();
    expect(within(await card('AVM-15')).getByText('En la cola de Luis Torres')).toBeTruthy();
    expect(within(await card('AVM-13')).getByText('Marta Gómez lo validó el 25/11/2026: PASSED')).toBeTruthy();
    expect((await card('AVM-11')).querySelector('.tk-claim')).toBeNull();

    fireEvent.click(within(luis).getByRole('button', { name: 'Ejecutar orquestador QA' }));
    expect(await running()).toEqual([]);
    fireEvent.click(within(luis).getByRole('button', { name: '¿Lanzar igual?' }));
    await expect.poll(running).toEqual(['AVM-12']);
  });

  it('a ticket a teammate already validated launches with one click; the second click is only for running or queued', async () => {
    render(<App />);
    fireEvent.click(within(await card('AVM-13')).getByRole('button', { name: 'Ejecutar orquestador QA' }));
    await expect.poll(running).toEqual(['AVM-13']);
  });

  it('"Validate all" leaves the teammates\' tickets unchecked and says who has them', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Validar todos (4)' }));
    const dialog = await screen.findByRole('dialog');
    const checked = Object.fromEntries(within(dialog).getAllByRole<HTMLInputElement>('checkbox').map((c) => [c.getAttribute('aria-label'), c.checked]));
    expect(checked).toEqual({ 'AVM-13': false, 'AVM-11': true, 'AVM-12': false, 'AVM-15': false });
    expect(within(dialog).getByText(/Los tickets que alguien del equipo está validando, tiene en cola o ya validó quedan sin marcar/)).toBeTruthy();
    const row = within(dialog).getByRole('checkbox', { name: 'AVM-12' }).closest('li')!;
    expect(row.textContent).toContain('Luis Torres lo está validando');
  });
});
