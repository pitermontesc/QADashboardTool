import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseInfo } from '../shared/types.js';

/** Where new versions are published (GitHub Releases, public: read without a token). */
export const RELEASES_REPO = 'pitermontesc/QADashboardTool';
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;

/** The newest published version, or null if there is none; injectable so tests and the demo never ask GitHub. */
export type LatestRelease = () => Promise<ReleaseInfo | null>;

/** The app's version, from its package.json (two folders up from dist/server, also inside the packaged app). */
export function appVersion(): string {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

/** Compares two `major.minor.patch` versions (a leading `v` and anything after a `-` are ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: { name?: unknown; browser_download_url?: unknown }[];
}

/** Notes are shown as plain text: long ones are cut. */
const MAX_NOTES = 4000;

/** A GitHub release as the app shows it; null for a draft, a pre-release or one without a version tag. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  const r = (json ?? {}) as GithubRelease;
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') return null;
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1];
  if (!version) return null;
  const published = typeof r.published_at === 'string' ? Date.parse(r.published_at) : Number.NaN;
  const downloads = (r.assets ?? []).flatMap((a) => {
    const name = typeof a.name === 'string' ? a.name : '';
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : '';
    const found = /-(arm64|x64)\.(dmg|zip)$/.exec(name);
    return found && url.startsWith('https://') ? [{ name, url, arch: found[1] as 'arm64' | 'x64', kind: found[2] as 'dmg' | 'zip' }] : [];
  });
  const notes = typeof r.body === 'string' ? r.body.trim() : '';
  return {
    version,
    url: typeof r.html_url === 'string' && r.html_url.startsWith('https://') ? r.html_url : `${RELEASES_PAGE}/tag/v${version}`,
    publishedAt: Number.isNaN(published) ? null : published,
    notes: notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES).trimEnd()}…` : notes,
    downloads,
  };
}

/** Asks GitHub for the latest release. Sends nothing about the user: no token, a generic User-Agent. */
export const fetchLatestRelease =
  (fetchImpl: typeof fetch = fetch): LatestRelease =>
  async () => {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'QA-Dashboard-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
    // No release published yet.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
    return parseRelease(await response.json());
  };
