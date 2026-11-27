// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import { parseRelease } from '../src/server/updates';
import type { ReleaseInfo } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.21.0, UI): when a newer version is published, the header says so and leads to
 * "App version" in the settings, with the installer for this Mac, how to install it and what
 * changed. Help → Check for updates opens that card and checks.
 */
const RELEASE = parseRelease({
  tag_name: 'v1.21.0',
  html_url: 'https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.21.0',
  published_at: '2026-11-27T10:00:00Z',
  body: '### Added\n- Updates inside the app\n- A **bold** word and `code`',
  // The other architecture's installer first: the card must pick this Mac's, not the first one.
  assets: (process.arch === 'arm64' ? ['x64', 'arm64'] : ['arm64', 'x64']).map((arch) => ({ name: `QA-Dashboard-1.21.0-${arch}.dmg`, browser_download_url: `https://github.com/dl/${arch}.dmg` })),
})!;
const ARCH = process.arch === 'arm64' ? 'Apple Silicon' : 'Intel';

describe('App updates', () => {
  let latest: ReleaseInfo | null = RELEASE;
  let asked = 0;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      version: '1.20.0',
      latestRelease: async () => {
        asked++;
        return latest;
      },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(new URL(url, srv.base), init));
    Element.prototype.scrollIntoView ??= () => undefined;
  });
  afterEach(() => cleanup());
  afterAll(async () => {
    vi.unstubAllGlobals();
    await srv.close();
  });

  it('a newer version: the header says so and the card has the installer for this Mac and how to install it', async () => {
    latest = RELEASE;
    await srv.call('POST', '/api/updates/check', {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Versión 1\.21\.0 disponible/ }));
    const card = (await screen.findByRole('heading', { name: 'Versión de la app' })).closest('.card') as HTMLElement;
    expect(within(card).getByText(`Tienes la versión 1.20.0 para ${ARCH}.`)).toBeTruthy();
    expect(within(card).getByText('Hay una versión nueva')).toBeTruthy();
    const download = within(card).getByRole('link', { name: `Descargar para ${ARCH} (.dmg)` });
    expect(download.getAttribute('href')).toBe(`https://github.com/dl/${process.arch}.dmg`);
    expect(within(card).getByRole('link', { name: /Ver el release en GitHub/ }).getAttribute('href')).toBe(RELEASE.url);
    expect(within(card.querySelector('.update-steps') as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    // The notes' Markdown shows as a heading and a list, not as raw symbols.
    expect(within(card).getByRole('heading', { name: 'Added', level: 5 })).toBeTruthy();
    expect(within(card).getByText('Updates inside the app').tagName).toBe('LI');
    expect(card.textContent).not.toContain('###');
    expect(within(card).getByText('bold').tagName).toBe('B');
    expect(within(card).getByText('code').tagName).toBe('CODE');
  });

  it('up to date: no header notice, and the card says which version is the latest', async () => {
    latest = { ...RELEASE, version: '1.20.0' };
    await srv.call('POST', '/api/updates/check', {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tipos y ajustes' }));
    expect(await screen.findByText('Estás al día: la última versión publicada es la 1.20.0.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /disponible/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Descargar/ })).toBeNull();
  });

  it('Help → Check for updates opens the card and asks GitHub again', async () => {
    latest = null;
    render(<App />);
    await screen.findByRole('button', { name: 'Tipos y ajustes' });
    const before = asked;
    latest = RELEASE;
    act(() => {
      window.dispatchEvent(new CustomEvent('app-command', { detail: 'check-updates' }));
    });
    expect(await screen.findByRole('link', { name: `Descargar para ${ARCH} (.dmg)` })).toBeTruthy();
    expect(asked).toBe(before + 1);
    expect(screen.getByRole('button', { name: /Versión 1\.21\.0 disponible/ })).toBeTruthy();
  });
});
