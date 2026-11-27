// @vitest-environment jsdom
import { readFileSync, rmSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { startServer } from './helpers';

/**
 * Contract (v1.20.0, UI): "My QA profile" in the settings fills the tester from the Jira account,
 * finds the TC executor in Jira by name, checks what is typed, and saves the file the skills read;
 * the "Set up this Mac" card then shows the profile as ready.
 */
const PEOPLE = [
  { displayName: 'Ana Ríos', accountId: '712020:aaaa-1111', accountType: 'atlassian', active: true },
  { displayName: 'Luis Torres', accountId: '712020:bbbb-2222', accountType: 'atlassian', active: true },
];
const jira: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/rest/api/3/myself') return Response.json(PEOPLE[0]);
  if (url.pathname === '/rest/api/3/user/search') {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    return Response.json(PEOPLE.filter((p) => p.displayName.toLowerCase().includes(q)));
  }
  return Response.json({ issues: [] });
};

describe('My QA profile', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ fetchImpl: jira, launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }) });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
  });
  afterEach(async () => {
    cleanup();
    rmSync(srv.profileFile, { force: true });
    await srv.call('POST', '/api/setup/check', {});
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  const openCard = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    const card = (await screen.findByRole('heading', { name: 'Mi perfil QA' })).closest('.card') as HTMLElement;
    await within(card).findByLabelText('Tester (tú): Nombre'); // The profile was read.
    return card;
  };

  it('without Jira, the tester is typed by hand and there is no search', async () => {
    const card = await openCard();
    expect((within(card).getByRole('button', { name: 'Usar mi cuenta de Jira' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByText('Conecta Jira más abajo para tomar tu nombre y accountId de tu cuenta')).toBeTruthy();
    expect(within(card).queryByRole('search')).toBeNull();
    expect(within(card).getByText(/todavía no existe: se crea al guardar/)).toBeTruthy();
  });

  it('takes the tester from Jira, finds the executor, saves the file and the setup card sees it', async () => {
    await srv.call('PUT', '/api/jira/config', { site: 'https://example.atlassian.net', email: 'qa@example.com', jql: '', token: 'x' });
    await srv.call('POST', '/api/jira/refresh', {});
    const card = await openCard();
    const setupRow = () => within(screen.getByRole('heading', { name: 'Preparar esta Mac' }).closest('.card') as HTMLElement).getByText('Perfil QA').closest('li')!;
    expect(setupRow().textContent).toContain('Recomendado');

    fireEvent.click(within(card).getByRole('button', { name: 'Usar mi cuenta de Jira' }));
    await waitFor(() => expect(within(card).getByLabelText<HTMLInputElement>('Tester (tú): Nombre').value).toBe('Ana Ríos'));
    expect(within(card).getByLabelText<HTMLInputElement>('Tester (tú): accountId de Jira').value).toBe('712020:aaaa-1111');

    fireEvent.change(within(card).getByLabelText('Buscar en Jira por nombre'), { target: { value: 'luis' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Buscar' }));
    fireEvent.click(await within(card).findByRole('button', { name: 'Elegir a Luis Torres como ejecutor de TCs' }));
    expect(within(card).getByLabelText<HTMLInputElement>('Ejecutor de TCs: accountId de Jira').value).toBe('712020:bbbb-2222');

    fireEvent.click(within(card).getByRole('button', { name: 'Guardar perfil' }));
    expect(await screen.findByText('Perfil QA guardado')).toBeTruthy();
    expect(JSON.parse(readFileSync(srv.profileFile, 'utf8'))).toEqual({
      tester: { name: 'Ana Ríos', accountId: '712020:aaaa-1111' },
      tcExecutor: { name: 'Luis Torres', accountId: '712020:bbbb-2222' },
    });
    await waitFor(() => expect(setupRow().textContent).toContain('a nombre de Ana Ríos'));
    // Saved: nothing new to save.
    expect((within(card).getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('checks what is typed: a tester is needed, an accountId must look like one, and the executor is whole or none', async () => {
    const card = await openCard();
    const saveBtn = () => within(card).getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement;
    const type = (label: string, value: string) => fireEvent.change(within(card).getByLabelText(label), { target: { value } });
    expect(saveBtn().disabled).toBe(true);
    expect(within(card).getByText('Completa tu nombre y tu accountId')).toBeTruthy();
    type('Tester (tú): Nombre', 'Ana');
    type('Tester (tú): accountId de Jira', 'ana@example.com');
    expect(within(card).getByText(/Eso no parece un accountId de Jira/)).toBeTruthy();
    type('Tester (tú): accountId de Jira', '712020:aaaa-1111');
    expect(saveBtn().disabled).toBe(false);
    type('Ejecutor de TCs: Nombre', 'Luis');
    expect(within(card).getByText('Completa nombre y accountId del ejecutor, o quítalo')).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Quitar ejecutor' }));
    fireEvent.click(saveBtn());
    expect(await screen.findByText('Perfil QA guardado')).toBeTruthy();
    expect(JSON.parse(readFileSync(srv.profileFile, 'utf8'))).toEqual({ tester: { name: 'Ana', accountId: '712020:aaaa-1111' } });
  });
});
