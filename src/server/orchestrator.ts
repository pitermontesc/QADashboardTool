import { ORCHESTRATOR_SKILL, REGRESSION_SKILL, SMOKE_SITES, SMOKE_SKILL, isSmokeSite, isTestRunRef, isTicketKey } from '../shared/orchestrator.js';
import { HttpError } from './errors.js';

/*
 * Prompts de Claude Code para cada skill. Van como un argumento del proceso (nunca
 * por una shell), así que no hace falta escapar nada; las entradas se validan igual.
 */

/** Orquestador QA sobre un ticket. */
export function orchestratorPrompt(key: string, extra = ''): string {
  if (!isTicketKey(key)) throw new HttpError(400, `Ticket inválido: ${key}`);
  return `${ORCHESTRATOR_SKILL} ${key}${extra}`;
}

/** Runner de regresión; sin test run, el skill usa el que corresponda o lo reporta como BLOCKED. */
export function regressionPrompt(run: string, extra = ''): string {
  if (!isTestRunRef(run)) throw new HttpError(400, 'Test run inválido: pega el link de testomat.io o su ID (p. ej. #b333fb92)');
  return `${run ? `${REGRESSION_SKILL} ${run}` : REGRESSION_SKILL}${extra}`;
}

/** Smoke tester sobre el sitio elegido (QA o STG). */
export function smokePrompt(site: unknown, extra = ''): string {
  if (!isSmokeSite(site)) throw new HttpError(400, 'Elige el sitio del smoke: QA o STG');
  const { label, url } = SMOKE_SITES[site];
  return `${SMOKE_SKILL} run smoke on ${label} (${url})${extra}`;
}
