import { REGRESSION_DRY_RUN, findSite, isTestRunRef, isTicketKey } from '../shared/orchestrator.js';
import type { QaConfig } from '../shared/types.js';
import { HttpError } from './errors.js';

/*
 * Claude Code prompts for each skill, using the skills and sites from the settings. They go
 * as a process argument (never through a shell); inputs are validated anyway.
 */

/** "QA or STG", "QA, STG or PROD"… (translated to Spanish with the error message). */
export const orList = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

/** QA orchestrator on a ticket. */
export function orchestratorPrompt(key: string, qa: QaConfig, extra = ''): string {
  if (!isTicketKey(key)) throw new HttpError(400, `Invalid ticket: ${key}`);
  return `${qa.skills.orchestrator} ${key}${extra}`;
}

/** Regression runner; without a test run, the skill picks the right one or reports BLOCKED. */
export function regressionPrompt(run: string, qa: QaConfig, extra = '', dryRun = false): string {
  if (!isTestRunRef(run, qa.testRunHosts)) {
    throw new HttpError(400, `Invalid test run: paste its link (${qa.testRunHosts.join(', ') || 'no domains configured'}) or its ID (e.g. #b333fb92)`);
  }
  return `${run ? `${qa.skills.regression} ${run}` : qa.skills.regression}${dryRun ? REGRESSION_DRY_RUN : ''}${extra}`;
}

/** Smoke tester on one of the configured sites. */
export function smokePrompt(siteId: unknown, qa: QaConfig, extra = ''): string {
  const site = findSite(siteId, qa);
  if (!site) throw new HttpError(400, `That site does not exist: choose ${orList(qa.sites.map((s) => s.name))}`);
  return `${qa.skills.smoke} run smoke on ${site.name} (${site.url})${extra}`;
}
