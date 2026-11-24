import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Contract: the README's API table lists every route the server answers, with its method. */
describe('README API table', () => {
  const source = readFileSync('src/server/app.ts', 'utf8');
  const readme = readFileSync('README.md', 'utf8');

  /** "POST /api/smoke" for every api.<method>('/path' or ['/a', '/b']) in the server. */
  const routes = [...source.matchAll(/api\.(get|post|put|delete)\((\[[^\]]*\]|'[^']*')/g)].flatMap(([, method, paths]) =>
    [...paths!.matchAll(/'([^']*)'/g)].map(([, p]) => `${method!.toUpperCase()} /api${p}`),
  );
  /** The same from the table rows: "| PUT / DELETE | `/api/runs/:id` | …". */
  const documented = new Set(
    [...readme.matchAll(/^\| ([A-Z /]+) \| `(\/api\/[^`]*)` \|/gm)].flatMap(([, methods, p]) => methods!.split('/').map((m) => `${m.trim()} ${p}`)),
  );

  it('finds the routes it checks', () => {
    expect(routes).toContain('GET /api/state');
    expect(routes.length).toBeGreaterThan(15);
  });

  it('documents every route', () => {
    // The result route also answers without the key (to refuse it with 403); the table documents the keyed one.
    const missing = routes.filter((r) => !documented.has(r) && r !== 'POST /api/automation/:id/result');
    expect(missing).toEqual([]);
  });

  it('documents no route that no longer exists', () => {
    expect([...documented].filter((r) => !routes.includes(r))).toEqual([]);
  });
});
