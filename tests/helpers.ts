import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../src/server/app';
import { Store } from '../src/server/store';

/** Starts the real API on a free port with a temporary data file. */
export async function startServer(options: AppOptions = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
  // Tests never launch the real Claude to translate.
  const translateReport: AppOptions['translateReport'] = async () => {
    throw new Error('no translator in tests');
  };
  // Each run's report key travels in its prompt, as it does to Claude; the tests report with it like Claude does.
  const reportKeys = new Map<string, string>();
  const fake = options.launchClaude;
  const launchClaude: AppOptions['launchClaude'] = fake
    ? async (job) => {
        const found = /\/api\/automation\/([\w-]+)\/result\/([0-9a-f]+)/.exec(job.prompt);
        if (found) reportKeys.set(found[1]!, found[2]!);
        return fake(job);
      }
    : undefined;
  const server = createApp(new Store(file), { translateReport, ...options, launchClaude }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    file,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    reportKey: (id: string) => reportKeys.get(id) ?? '',
    call: async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      // A result posted to the bare URL uses the run's key, like Claude's report URL (…/result/<key>).
      const result = /^\/api\/automation\/([\w-]+)\/result$/.exec(url);
      if (result && reportKeys.has(result[1]!)) url += `/${reportKeys.get(result[1]!)}`;
      const res = await fetch(base + url, {
        method,
        // Like the app: every change is JSON, even without a body.
        headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
    },
  };
}

/** Last JQL received by the simulated Jira board endpoint. */
export let lastBoardJql = '';

/** Tickets the simulated Jira adds to the JQL search (to test new tickets). */
export const extraIssues: { key: string; summary: string; status: string }[] = [];

/** Simulated Jira: only accepts the token "good"; the JQL search returns two tickets and board 1 returns sixty. */
export const fakeJira: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  const [, token] = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':');
  if (token !== 'good') return new Response('{}', { status: 401 });
  if (url.pathname === '/rest/agile/1.0/board/1/issue') {
    // Board with 60 tickets that Jira returns 50 at a time.
    lastBoardJql = url.searchParams.get('jql') ?? '';
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    const keys = Array.from({ length: 60 }, (_, i) => `AVM-${i + 1}`).slice(startAt, startAt + 50);
    return Response.json({
      total: 60,
      issues: keys.map((key) => ({ key, fields: { summary: key, status: { name: 'On QA' }, issuetype: { name: 'Story' } } })),
    });
  }
  if (url.pathname !== '/rest/api/3/search/jql') return new Response('{}', { status: 404 });
  if (url.searchParams.get('jql')?.includes('BAD')) {
    return Response.json({ errorMessages: ['Malformed JQL'] }, { status: 400 });
  }
  return Response.json({
    issues: [
      { key: 'AVM-101', fields: { summary: 'Work order totals', status: { name: 'On QA' }, issuetype: { name: 'Story' } } },
      { key: 'AVM-102', fields: { summary: 'Vendor <import> & export', status: { name: 'Test' }, issuetype: { name: 'Bug' } } },
      ...extraIssues.map(({ key, summary, status }) => ({ key, fields: { summary, status: { name: status }, issuetype: { name: 'Story' } } })),
    ],
  });
};
