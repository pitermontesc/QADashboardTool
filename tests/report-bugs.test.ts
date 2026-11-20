import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers';

/**
 * Contract: once a run has finished, the user can edit its report's bugs (key, link, title,
 * severity, module), add and remove them. The original report and its translations show the
 * same bugs; a text the user did not touch keeps each language's wording.
 */
describe('Editing the bugs of a report', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const SITE = 'https://example.atlassian.net';

  beforeAll(async () => {
    srv = await startServer({
      launchClaude: async () => ({ pid: null, logFile: '', stop: () => undefined }),
      // The "translation" returns the same report with English titles and modules.
      translateReport: async () => ({
        summary: 'Smoke with 2 bugs',
        details: {
          build: '', notes: '', modules: [],
          bugs: [
            { title: 'Back keeps the last record', severity: 'Medium', key: '', link: '', module: 'Assets' },
            { title: 'Raw status in the table', severity: 'Low', key: '', link: '', module: 'Assets' },
          ],
        },
      }),
    });
    await srv.call('PUT', '/api/jira/config', { site: SITE, email: 'qa@example.com', jql: '', token: 'x' });
  });
  afterAll(() => srv.close());

  /** A finished smoke whose report (in Spanish, the app language) has two bugs. */
  const finished = async () => {
    const { body: a } = await srv.call('POST', '/api/smoke', { site: 'qa' });
    await srv.call('POST', `/api/automation/${a.id}/result`, {
      verdict: 'GO', summary: 'Smoke con 2 bugs', bugs: 2,
      details: {
        bugs: [
          { title: 'Atrás deja el último registro', severity: 'Medium', module: 'Activos' },
          { title: 'Estado sin formato en la tabla', severity: 'Low', module: 'Activos' },
        ],
      },
    });
    return a.id as string;
  };
  const state = async (id: string) => {
    const { body } = await srv.call('GET', '/api/state');
    const automation = body.automations.find((a: { id: string }) => a.id === id);
    return { automation, run: body.runs.find((r: { id: string }) => r.id === automation.runId) };
  };
  const edit = (id: string, lang: string, bugs: unknown[]) => srv.call('PUT', `/api/automation/${id}/bugs`, { lang, bugs });

  it('a key without a link links to the bug in Jira, and removing or adding bugs updates the run count', async () => {
    const id = await finished();
    const res = await edit(id, 'es', [
      { from: 1, title: 'Estado sin formato en la tabla', severity: 'Low', key: 'avm-7145', link: '', module: 'Activos' },
      { from: null, title: 'Bug nuevo', severity: 'High', key: '', link: 'https://example.com/b/1', module: '' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.details.bugs).toEqual([
      { title: 'Estado sin formato en la tabla', severity: 'Low', key: 'AVM-7145', link: `${SITE}/browse/AVM-7145`, module: 'Activos' },
      { title: 'Bug nuevo', severity: 'High', key: '', link: 'https://example.com/b/1', module: '' },
    ]);
    // Read back from the server: it was saved, and the test run counts 2 bugs.
    const { automation, run } = await state(id);
    expect(automation.details.bugs.map((b: { key: string }) => b.key)).toEqual(['AVM-7145', '']);
    expect(run.bugs).toBe(2);
    await edit(id, 'es', []);
    expect((await state(id)).run.bugs).toBe(0);
  });

  it('a link typed by the user is kept; changing the key replaces a link that pointed to the old key', async () => {
    const id = await finished();
    await edit(id, 'es', [
      { from: 0, title: 'Atrás deja el último registro', severity: 'Medium', key: 'AVM-1', link: 'https://example.com/custom', module: 'Activos' },
      { from: 1, title: 'Estado sin formato en la tabla', severity: 'Low', key: 'AVM-2', link: '', module: 'Activos' },
    ]);
    const { automation } = await state(id);
    expect(automation.details.bugs[0].link).toBe('https://example.com/custom');
    // The key changes and the link is still the one for AVM-2: it now points to AVM-3.
    await edit(id, 'es', [{ ...automation.details.bugs[1], from: 1, key: 'AVM-3' }]);
    expect((await state(id)).automation.details.bugs).toEqual([
      { title: 'Estado sin formato en la tabla', severity: 'Low', key: 'AVM-3', link: `${SITE}/browse/AVM-3`, module: 'Activos' },
    ]);
  });

  it('edited from the translation: untouched texts keep each language, changed texts and keys are the same in both', async () => {
    const id = await finished();
    expect((await srv.call('POST', `/api/automation/${id}/translate`, { lang: 'en' })).status).toBe(200);
    // The user sees the English report: adds the key to the first bug and rewrites the second title.
    await edit(id, 'en', [
      { from: 0, title: 'Back keeps the last record', severity: 'Medium', key: 'AVM-7144', link: '', module: 'Assets' },
      { from: 1, title: 'ON_WORK_ORDER shown raw', severity: 'Low', key: '', link: '', module: 'Assets' },
    ]);
    const { automation } = await state(id);
    expect(automation.details.bugs).toEqual([
      { title: 'Atrás deja el último registro', severity: 'Medium', key: 'AVM-7144', link: `${SITE}/browse/AVM-7144`, module: 'Activos' },
      { title: 'ON_WORK_ORDER shown raw', severity: 'Low', key: '', link: '', module: 'Activos' },
    ]);
    expect(automation.translations.en.details.bugs).toEqual([
      { title: 'Back keeps the last record', severity: 'Medium', key: 'AVM-7144', link: `${SITE}/browse/AVM-7144`, module: 'Assets' },
      { title: 'ON_WORK_ORDER shown raw', severity: 'Low', key: '', link: '', module: 'Assets' },
    ]);
  });

  it('refuses a bug without a title, a run still in progress and a run that does not exist', async () => {
    const id = await finished();
    const noTitle = await edit(id, 'es', [{ from: 0, title: '  ', severity: '', key: '', link: '', module: '' }]);
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error).toContain('Cada bug necesita un título');
    expect((await state(id)).automation.details.bugs).toHaveLength(2);
    const badLink = await edit(id, 'es', [{ from: 0, title: 'x', link: 'javascript:alert(1)' }]);
    expect(badLink.status).toBe(400);

    const { body: running } = await srv.call('POST', '/api/smoke', { site: 'stg' });
    const busy = await edit(running.id, 'es', []);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('Esa ejecución todavía está en curso');
    expect((await edit('nope', 'es', [])).status).toBe(404);
  });
});
