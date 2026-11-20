import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers';

/**
 * Contract: a regression launched in test mode tells Claude to only read Jira and testomat.io
 * (no epic, tasks, bugs, comments or marked results), is labeled as such in its title and run,
 * and never offers a Jira comment for posting. Without test mode, the prompt is unchanged.
 */
describe('Regression in test mode', () => {
  const prompts: string[] = [];
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({
      launchClaude: async (job) => {
        prompts.push(job.prompt);
        return { pid: null, logFile: '', stop: () => undefined };
      },
    });
  });
  afterAll(() => srv.close());
  const runOf = async (runId: string) => (await srv.call('GET', '/api/state')).body.runs.find((r: { id: string }) => r.id === runId);

  it('tells Claude to write nothing to Jira or testomat.io, and labels the run as test mode', async () => {
    const { status, body: a } = await srv.call('POST', '/api/regression', { run: '#b333fb92', dryRun: true });
    expect(status).toBe(200);
    expect(a.dryRun).toBe(true);
    expect(a.title).toBe('Regression #b333fb92 con Claude (modo prueba)');
    const prompt = prompts.at(-1)!;
    expect(prompt.startsWith('/avm-qa-skills:avm-regression-runner #b333fb92 -- TEST MODE')).toBe(true);
    expect(prompt).toContain('do not mark results');
    expect(prompt).toContain('no epic, no suite tasks, no bugs, no comments');
    // The report instruction still follows, so Claude reports to the dashboard.
    expect(prompt).toContain(`/api/automation/${a.id}/result`);
    expect((await runOf(a.runId)).title).toBe('Regression #b333fb92 con Claude (modo prueba) · en curso');
  });

  it('drops a Jira comment Claude prepared anyway, so the app cannot post it', async () => {
    const { body: a } = await srv.call('POST', '/api/regression', { run: '#c0ffee12', dryRun: true });
    const { body: done } = await srv.call('POST', `/api/automation/${a.id}/result`, {
      verdict: 'GO', summary: 'All good', details: { bugs: [{ title: 'Login slow' }], jiraComment: { key: 'AVM-1', body: 'Regression GO' } },
    });
    expect(done.details.jiraComment).toBeNull();
    expect(done.details.bugs).toHaveLength(1);
    expect((await srv.call('POST', `/api/automation/${a.id}/jira-comment`, {})).status).toBe(404);
    expect((await runOf(a.runId)).title).toBe('Regression #c0ffee12 con Claude (modo prueba) · GO');
  });

  it('keeps the test-mode label when the app language changes', async () => {
    const { body: a } = await srv.call('POST', '/api/regression', { run: '#facade99', dryRun: true });
    const settings = (await srv.call('GET', '/api/state')).body.settings;
    await srv.call('PUT', '/api/settings', { ...settings, language: 'en' });
    const state = (await srv.call('GET', '/api/state')).body;
    expect(state.automations.find((x: { id: string }) => x.id === a.id).title).toBe('Regression #facade99 with Claude (test mode)');
    await srv.call('PUT', '/api/settings', { ...settings, language: 'es' });
  });

  it('without test mode the prompt and title are the usual ones, and a Jira comment is kept', async () => {
    const { body: a } = await srv.call('POST', '/api/regression', { run: '#beef1234', dryRun: 'yes' });
    expect(a.dryRun).toBe(false);
    expect(a.title).toBe('Regression #beef1234 con Claude');
    expect(prompts.at(-1)).not.toContain('TEST MODE');
    const { body: done } = await srv.call('POST', `/api/automation/${a.id}/result`, {
      verdict: 'GO', details: { jiraComment: { key: 'AVM-2', body: 'Regression GO' } },
    });
    expect(done.details.jiraComment.key).toBe('AVM-2');
  });
});
