/** Skill de Claude Code que valida un ticket de AVM con agentes. */
export const ORCHESTRATOR_SKILL = '/avm-qa-orchestrator';
/** Skill de Claude Code que ejecuta un test run de testomat.io contra staging. */
export const REGRESSION_SKILL = '/avm-qa-skills:avm-regression-runner';

/** Estados de Jira en los que un ticket está listo para el orquestador. */
const READY_STATUSES = new Set(['on qa', 'on staging', 'on stagging']);

export const canOrchestrate = (status: string): boolean => READY_STATUSES.has(status.trim().toLowerCase());

/** Claves de Jira válidas (AVM-7057). Solo estas llegan a la línea de comandos. */
export const isTicketKey = (key: string): boolean => /^[A-Z][A-Z0-9_]*-\d+$/.test(key);

/** Suites a las que se ofrece el runner de regresión. */
export const isRegressionType = (name: string): boolean => /regres/i.test(name);

/**
 * Test run de testomat.io: vacío (el skill lo pide), un ID como `#b333fb92`
 * o un link de testomat.io. Sin comillas ni espacios: va dentro de la línea de comandos.
 */
export function isTestRunRef(ref: string): boolean {
  if (ref === '') return true;
  if (/^#?[A-Za-z0-9-]{4,64}$/.test(ref)) return true;
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9\-._~/?=&#%:+]*$/.test(ref)) return false;
  const host = new URL(ref).hostname;
  return host === 'testomat.io' || host.endsWith('.testomat.io');
}
