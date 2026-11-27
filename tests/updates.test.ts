import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseNotes } from '../scripts/release-notes';
import { compareVersions, fetchLatestRelease, parseRelease } from '../src/server/updates';
import type { ReleaseInfo } from '../src/shared/types';
import { startServer } from './helpers';

/**
 * Contract (v1.21.0): new versions are GitHub releases (an installer per Mac architecture, the
 * CHANGELOG section as notes). The app asks GitHub for the latest one, without a token or anything
 * about the user, and says whether it is newer than itself. A failed check never breaks the app.
 */

const github = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/pitermontesc/QADashboardTool/releases/tag/${tag}`,
  published_at: '2026-11-27T10:00:00Z',
  body: '### Added\n- Something new',
  draft: false,
  prerelease: false,
  assets: [
    { name: `QA-Dashboard-${tag.slice(1)}-arm64.dmg`, browser_download_url: `https://github.com/x/${tag}/arm64.dmg` },
    { name: `QA-Dashboard-${tag.slice(1)}-x64.dmg`, browser_download_url: `https://github.com/x/${tag}/x64.dmg` },
    { name: `QA-Dashboard-${tag.slice(1)}-arm64.zip`, browser_download_url: `https://github.com/x/${tag}/arm64.zip` },
    { name: `QA-Dashboard-${tag.slice(1)}-arm64.dmg.blockmap`, browser_download_url: 'https://github.com/x/blockmap' },
    { name: 'evil-arm64.dmg', browser_download_url: 'http://example.com/evil.dmg' },
  ],
  ...extra,
});

describe('Versions and releases', () => {
  it('compares versions by number, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.20.0', '1.20.0')).toBe(0);
    expect(compareVersions('1.20.0', '1.20.1')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.21.0-beta.1', '1.21.0')).toBe(0);
  });

  it('reads a release: its version, page, date, notes and an installer per architecture', () => {
    expect(parseRelease(github('v1.21.0'))).toEqual({
      version: '1.21.0',
      url: 'https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.21.0',
      publishedAt: Date.parse('2026-11-27T10:00:00Z'),
      notes: '### Added\n- Something new',
      // The block maps and a download that is not https are left out.
      downloads: [
        { name: 'QA-Dashboard-1.21.0-arm64.dmg', url: 'https://github.com/x/v1.21.0/arm64.dmg', arch: 'arm64', kind: 'dmg' },
        { name: 'QA-Dashboard-1.21.0-x64.dmg', url: 'https://github.com/x/v1.21.0/x64.dmg', arch: 'x64', kind: 'dmg' },
        { name: 'QA-Dashboard-1.21.0-arm64.zip', url: 'https://github.com/x/v1.21.0/arm64.zip', arch: 'arm64', kind: 'zip' },
      ],
    });
  });

  it('ignores drafts, pre-releases and tags that are not a version, and cuts very long notes', () => {
    expect(parseRelease(github('v1.21.0', { draft: true }))).toBeNull();
    expect(parseRelease(github('v1.21.0', { prerelease: true }))).toBeNull();
    expect(parseRelease(github('nightly'))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    const long = parseRelease(github('v1.21.0', { body: 'x'.repeat(5000), html_url: 'javascript:alert(1)', published_at: 'soon' }))!;
    expect(long.notes).toHaveLength(4001);
    expect(long.notes.endsWith('…')).toBe(true);
    expect(long.url).toBe('https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.21.0');
    expect(long.publishedAt).toBeNull();
  });

  it('asks GitHub for the latest release with no token and a generic name; none yet is not an error', async () => {
    const asked: { url: string; headers: Headers }[] = [];
    const answer = (status: number, body: unknown): typeof fetch => async (input, init) => {
      asked.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json(body, { status });
    };
    expect((await fetchLatestRelease(answer(200, github('v1.21.0')))())!.version).toBe('1.21.0');
    expect(asked[0]!.url).toBe('https://api.github.com/repos/pitermontesc/QADashboardTool/releases/latest');
    expect(asked[0]!.headers.get('authorization')).toBeNull();
    expect(asked[0]!.headers.get('user-agent')).toBe('QA-Dashboard-update-check');
    expect(await fetchLatestRelease(answer(404, { message: 'Not Found' }))()).toBeNull();
    await expect(fetchLatestRelease(answer(403, { message: 'rate limit' }))()).rejects.toThrow('GitHub responded 403');
  });

  it('takes a release\'s notes from its CHANGELOG section', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const notes = releaseNotes(changelog, '1.20.0')!;
    expect(notes.startsWith('### Added\n- **My QA profile.**')).toBe(true);
    // Only that version: the next section is not included.
    expect(notes).not.toContain('## [');
    expect(notes).not.toContain('Set up this Mac.** A card');
    expect(releaseNotes(changelog, '1.0.0')).not.toContain(']: https://');
    expect(releaseNotes(changelog, '9.9.9')).toBeNull();
  });
});

describe('Update check in the app', () => {
  let latest: () => Promise<ReleaseInfo | null> = async () => null;
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ version: '1.20.0', latestRelease: () => latest() });
  });
  afterAll(() => srv.close());

  const check = async () => (await srv.call('POST', '/api/updates/check', {})).body.update;

  it('is not checked until asked (the first check waits a few seconds after the start)', async () => {
    expect((await srv.call('GET', '/api/state')).body.update).toMatchObject({ current: '1.20.0', arch: process.arch, latest: null, available: false, checkedAt: null });
  });

  it('a newer release is available; the same or an older one is not', async () => {
    latest = async () => parseRelease(github('v1.21.0'));
    const update = await check();
    expect(update).toMatchObject({ current: '1.20.0', available: true, error: null, latest: { version: '1.21.0' } });
    expect(update.checkedAt).toEqual(expect.any(Number));
    latest = async () => parseRelease(github('v1.20.0'));
    expect((await check()).available).toBe(false);
    latest = async () => parseRelease(github('v1.9.0'));
    expect((await check()).available).toBe(false);
    latest = async () => null;
    expect(await check()).toMatchObject({ available: false, latest: null, error: null });
  });

  it('a failed check says why and keeps the last answer; the app keeps working', async () => {
    latest = async () => parseRelease(github('v1.21.0'));
    await check();
    latest = async () => {
      throw new Error('GitHub responded 503');
    };
    expect(await check()).toMatchObject({ available: true, error: 'GitHub responded 503', latest: { version: '1.21.0' } });
    expect((await srv.call('GET', '/api/state')).status).toBe(200);
  });

  it('the demo has no update check', async () => {
    const demo = await startServer({ demo: true, latestRelease: async () => parseRelease(github('v9.0.0')) });
    expect((await demo.call('POST', '/api/updates/check', {})).body.update).toBeNull();
    await demo.close();
  });
});
