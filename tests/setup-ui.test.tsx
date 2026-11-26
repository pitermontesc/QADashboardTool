// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { readyFacts, type SetupFacts } from '../src/server/setup';
import { startServer } from './helpers';

/**
 * Contract (v1.19.0, UI): while this Mac is missing something runs with Claude need, the dashboard
 * says what and leads to "Set up this Mac" in the settings, which shows each check with how to fix
 * it (the command to copy) and checks again on request.
 */
const SKILLS = ['avm-qa-skills:avm-qa-orchestrator', 'avm-qa-skills:avm-smoke-tester', 'avm-qa-skills:avm-regression-runner'];

describe('Set up this Mac', () => {
  let facts: SetupFacts = readyFacts(SKILLS);
  let srv: Awaited<ReturnType<typeof startServer>>;
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  beforeAll(async () => {
    srv = await startServer({
      probeSetup: async () => structuredClone(facts),
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(async () => {
    cleanup();
    facts = readyFacts(SKILLS);
    await srv.call('POST', '/api/setup/check', {});
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  it('a Mac that is not ready: the dashboard says what is missing and the settings say how to fix it', async () => {
    facts = { ...readyFacts(SKILLS.slice(0, 2)), loggedIn: false, profile: { status: 'missing' } };
    await srv.call('POST', '/api/setup/check', {});
    render(<App />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('No se pueden lanzar ejecuciones con Claude: falta iniciar sesión en Claude Code y instalar las skills de QA.');

    fireEvent.click(within(banner).getByRole('button', { name: 'Ver cómo arreglarlo' }));
    const card = (await screen.findByRole('heading', { name: 'Preparar esta Mac' })).closest('.card') as HTMLElement;
    expect(within(card).getByText('Falta algo para ejecutar con Claude')).toBeTruthy();
    const row = (label: string) => within(card).getByText(label).closest('li') as HTMLElement;
    expect(row('Claude Code instalado').textContent).toContain('Versión simulated.');
    expect(row('Sesión iniciada en Claude Code').textContent).toContain('Falta');
    expect(row('Skills de QA').textContent).toContain('Falta avm-qa-skills:avm-regression-runner.');
    expect(row('Perfil QA').textContent).toContain('Recomendado');
    // Only what is missing has a command to copy.
    expect(within(row('Claude Code instalado')).queryByRole('button', { name: /^Copiar/ })).toBeNull();
    fireEvent.click(within(row('Sesión iniciada en Claude Code')).getByRole('button', { name: 'Copiar: claude auth login' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude auth login'));
    expect(within(row('Skills de QA')).getByText('/plugin install avm-qa-skills@claudeai-organization-library')).toBeTruthy();
  });

  it('"Check again" picks up a fix, and the dashboard notice goes away', async () => {
    facts = { ...facts, loggedIn: false };
    await srv.call('POST', '/api/setup/check', {});
    render(<App />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Tipos y ajustes' }));
    await screen.findByText('Falta algo para ejecutar con Claude');
    facts = readyFacts(SKILLS);
    fireEvent.click(screen.getByRole('button', { name: /Volver a revisar/ }));
    expect(await screen.findByText('Lista para ejecutar con Claude')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    await screen.findByRole('button', { name: 'Smoke en QA' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a skill name the app switched shows where it came from', async () => {
    const { settings } = (await srv.call('GET', '/api/state')).body;
    await srv.call('PUT', '/api/settings', { ...settings, qa: { ...settings.qa, skills: { ...settings.qa.skills, smoke: '/old-prefix:avm-smoke-tester' } } });
    await srv.call('POST', '/api/setup/check', {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    expect(await screen.findByText('Nombre ajustado al que tiene Claude Code: /old-prefix:avm-smoke-tester → /avm-qa-skills:avm-smoke-tester')).toBeTruthy();
    // The sites & skills card shows the new name too.
    expect(screen.getByDisplayValue('/avm-qa-skills:avm-smoke-tester')).toBeTruthy();
  });
});
