import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../src/server/app';
import { Store } from '../src/server/store';

/** Levanta la API real en un puerto libre con un archivo de datos temporal. */
export async function startServer(options: AppOptions = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-dash-')), 'qa-tests.json');
  const server = createApp(new Store(file), options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    file,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    call: async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
    },
  };
}

/** Último JQL que recibió el endpoint de board del Jira simulado. */
export let lastBoardJql = '';

/** Jira simulado: acepta solo el token "good"; la búsqueda JQL devuelve dos tickets y el board 1, sesenta. */
export const fakeJira: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  const [, token] = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':');
  if (token !== 'good') return new Response('{}', { status: 401 });
  if (url.pathname === '/rest/agile/1.0/board/1/issue') {
    // Board con 60 tickets que Jira entrega de a 50.
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
    return Response.json({ errorMessages: ['JQL mal formado'] }, { status: 400 });
  }
  return Response.json({
    issues: [
      { key: 'AVM-101', fields: { summary: 'Work order totals', status: { name: 'On QA' }, issuetype: { name: 'Story' } } },
      { key: 'AVM-102', fields: { summary: 'Vendor <import> & export', status: { name: 'Test' }, issuetype: { name: 'Bug' } } },
    ],
  });
};
