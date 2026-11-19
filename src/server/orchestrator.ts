import { findSite, isTestRunRef, isTicketKey } from '../shared/orchestrator.js';
import type { QaConfig } from '../shared/types.js';
import { HttpError } from './errors.js';

/*
 * Prompts de Claude Code para cada skill, con los skills y sitios de los ajustes. Van
 * como un argumento del proceso (nunca por una shell); las entradas se validan igual.
 */

/** «QA o STG», «QA, STG o PROD»… */
export const orList = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} o ${items.at(-1)}`;

/** Orquestador QA sobre un ticket. */
export function orchestratorPrompt(key: string, qa: QaConfig, extra = ''): string {
  if (!isTicketKey(key)) throw new HttpError(400, `Ticket inválido: ${key}`);
  return `${qa.skills.orchestrator} ${key}${extra}`;
}

/** Runner de regresión; sin test run, el skill usa el que corresponda o lo reporta como BLOCKED. */
export function regressionPrompt(run: string, qa: QaConfig, extra = ''): string {
  if (!isTestRunRef(run, qa.testRunHosts)) {
    throw new HttpError(400, `Test run inválido: pega el link (${qa.testRunHosts.join(', ') || 'sin dominios configurados'}) o su ID (p. ej. #b333fb92)`);
  }
  return `${run ? `${qa.skills.regression} ${run}` : qa.skills.regression}${extra}`;
}

/** Smoke tester sobre uno de los sitios configurados. */
export function smokePrompt(siteId: unknown, qa: QaConfig, extra = ''): string {
  const site = findSite(siteId, qa);
  if (!site) throw new HttpError(400, `Ese sitio no existe: elige ${orList(qa.sites.map((s) => s.name))}`);
  return `${qa.skills.smoke} run smoke on ${site.name} (${site.url})${extra}`;
}
