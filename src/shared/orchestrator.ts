import type { QaConfig, QaSite } from './types.js';

/**
 * Default QA config: the sites under test, the Claude Code skills and the Jira
 * statuses ready for the orchestrator. All of it is editable in
 * Types & settings → Sites and skills; these values are only used when nothing is saved.
 */
export function defaultQaConfig(): QaConfig {
  return {
    sites: [
      { id: 'qa', name: 'QA', url: 'https://qa.alpinevm.com', env: 'QA', jiraStatus: 'On QA' },
      { id: 'stg', name: 'STG', url: 'https://staging.alpinevm.com', env: 'STG', jiraStatus: 'On Staging' },
    ],
    regressionSiteId: 'stg',
    skills: {
      orchestrator: '/avm-qa-orchestrator',
      smoke: '/avm-qa-skills:avm-smoke-tester',
      regression: '/avm-qa-skills:avm-regression-runner',
    },
    testRunHosts: ['testomat.io'],
  };
}

const sameStatus = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Site where a ticket is tested, based on its Jira status; none if it is not ready for the orchestrator. */
export const siteForStatus = (status: string, qa: QaConfig): QaSite | undefined =>
  qa.sites.find((site) => site.jiraStatus.trim() !== '' && sameStatus(site.jiraStatus, status));

export const canOrchestrate = (status: string, qa: QaConfig): boolean => siteForStatus(status, qa) !== undefined;

/** Jira statuses ready for the orchestrator, for display ("On QA or On Staging"). */
export const readyStatuses = (qa: QaConfig): string[] => qa.sites.map((s) => s.jiraStatus).filter((s) => s.trim() !== '');

export const findSite = (id: unknown, qa: QaConfig): QaSite | undefined =>
  typeof id === 'string' ? qa.sites.find((site) => site.id === id) : undefined;

/** Valid Jira keys (AVM-7057). Only these reach the command line. */
export const isTicketKey = (key: string): boolean => /^[A-Z][A-Z0-9_]*-\d+$/.test(key);

/** Suites the regression runner is offered for. */
export const isRegressionType = (name: string): boolean => /regres/i.test(name);

/** Suites the smoke tester is offered for. */
export const isSmokeType = (name: string): boolean => /smoke/i.test(name);

/**
 * Test run: empty (the skill asks for it), an ID like `#b333fb92`, or an https link on
 * one of the configured domains (or their subdomains). No quotes or spaces.
 */
export function isTestRunRef(ref: string, hosts: readonly string[]): boolean {
  if (ref === '') return true;
  if (/^#?[A-Za-z0-9-]{4,64}$/.test(ref)) return true;
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9\-._~/?=&#%:+]*$/.test(ref)) return false;
  const host = new URL(ref).hostname;
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
