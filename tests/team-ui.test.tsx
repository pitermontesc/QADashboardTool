// @vitest-environment jsdom
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { buildTeamFile, writeTeamFile } from '../src/server/team';
import type { Automation, TestRun } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.22.0, UI): the Team tab (⌘4) joins a shared folder with a name (taken from the QA
 * profile), then shows the team's numbers, each person's row, who validated which ticket and the
 * latest runs. A teammate's report opens read only. Leaving takes this app's file out.
 */
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const anaRun: TestRun = {
  id: 'ana-run-1', createdAt: Date.now() - 60_000, date: ymd, typeId: 't-ana', title: 'Ana checks the vendor import', ticket: 'AVM-7064', env: 'STG',
  result: 'failed', passed: 4, failed: 1, blocked: 0, bugs: 1, minutes: 45, notes: '', testMode: false,
};
const anaReport = (extra: Partial<Automation>): Automation => ({
  id: 'ana-rep-1', kind: 'orchestrator', target: 'AVM-7064', title: 'Orquestador QA: Vendor import', env: 'STG', startedAt: Date.now() - 3_600_000,
  finishedAt: Date.now() - 3_000_000, verdict: 'FAILED', summary: 'AVM-7064 FAILED: duplicated contacts.', link: '', runId: 'ana-run-1', pid: null, logFile: '',
  lang: 'es', translations: {}, dryRun: false, fullCoverage: false, site: 'stg', ticketType: 'Story', queued: null,
  details: { build: '', modules: [], notes: '', bugs: [{ title: 'Duplicated contacts', severity: 'Major', key: 'AVM-9001', link: '', module: '' }], jiraComment: null },
  ...extra,
});

describe('Team view', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-team-ui-'));
  const folder = path.join(root, 'QA Team');
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
    writeFileSync(srv.profileFile, JSON.stringify({ tester: { name: 'Piter Montes', accountId: '712020:piter-0001' } }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  });
  afterEach(async () => {
    cleanup();
    await srv.call('DELETE', '/api/team');
    rmSync(folder, { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const openTeam = async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'Tipos y ajustes' });
    fireEvent.keyDown(window, { key: '4', metaKey: true, ctrlKey: true });
  };

  it('joins a folder with the name from the QA profile', async () => {
    await openTeam();
    const name = await screen.findByLabelText<HTMLInputElement>('Tu nombre en el equipo');
    await waitFor(() => expect(name.value).toBe('Piter Montes'));
    expect(screen.getByText(/Nunca se comparte: tu token ni tu email de Jira/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Carpeta del equipo'), { target: { value: folder } });
    fireEvent.click(screen.getByRole('button', { name: 'Unirme al equipo' }));
    const row = (await screen.findByText('Tú')).closest('tr')!;
    expect(row.textContent).toContain('Piter Montes');
    expect(screen.getByText(/Todavía no hay nadie más en esta carpeta/)).toBeTruthy();
    expect(readdirSync(folder)).toEqual([expect.stringMatching(/^piter-montes--.*\.qa-team\.json$/)]);
  });

  it('shows the teammates: their row, what they run now, the tickets they validated, and their report read only', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter Montes' });
    writeTeamFile(folder, buildTeamFile({ id: 'ana-0000-1111', name: 'Ana Ríos' }, '1.22.0', [{ id: 't-ana', name: 'Funcional', major: false, color: '#3b82c4' }], [anaRun], [
      anaReport({}),
      anaReport({ id: 'ana-rep-2', target: 'AVM-7068', finishedAt: null, verdict: null, runId: null, details: null }),
    ]));
    await openTeam();
    const perPerson = (await screen.findByRole('heading', { name: 'Por persona' })).closest('.card') as HTMLElement;
    const anaRow = (await within(perPerson).findByRole('cell', { name: /^Ana Ríos/ })).closest('tr')!;
    expect(within(anaRow).getByRole('button', { name: /Corriendo Orquestador AVM-7068/ })).toBeTruthy();
    expect([...anaRow.querySelectorAll('td.num')].map((td) => td.textContent)).toEqual(['1', '5', '80%', '1', '45 min']);
    expect(screen.getByText('2 personas')).toBeTruthy();
    expect(screen.getByText('Ana checks the vendor import').closest('tr')!.textContent).toContain('Ana Ríos');

    fireEvent.click(screen.getByRole('button', { name: 'AVM-7064' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Compartido por Ana Ríos desde la carpeta del equipo (solo lectura)')).toBeTruthy();
    expect(within(dialog).getByText('Duplicated contacts')).toBeTruthy();
    // Nothing can be changed from this Mac: only Close.
    expect(within(dialog).queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent?.trim() || b.getAttribute('aria-label'))).toEqual(['Cerrar', 'Cerrar']);
  });

  it('lists the files it could not read', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter Montes' });
    writeFileSync(path.join(folder, 'broken--00000000.qa-team.json'), '{');
    await openTeam();
    fireEvent.click(await screen.findByText(/Archivos que no se pudieron leer \(1\)/));
    expect(screen.getByText('broken--00000000.qa-team.json').closest('li')!.textContent).toContain('No es JSON válido');
  });

  it('leaving asks first, then takes this app\'s file out of the folder', async () => {
    await srv.call('PUT', '/api/team', { folder, name: 'Piter Montes' });
    await openTeam();
    fireEvent.click(await screen.findByRole('button', { name: 'Dejar el equipo' }));
    expect(readdirSync(folder)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sí, dejar el equipo' }));
    expect(await screen.findByRole('button', { name: 'Unirme al equipo' })).toBeTruthy();
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });
});
