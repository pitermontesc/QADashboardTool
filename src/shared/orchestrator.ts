/** Skill de Claude Code que valida un ticket de AVM con agentes. */
export const ORCHESTRATOR_SKILL = '/avm-qa-orchestrator';

/** Estados de Jira en los que un ticket está listo para el orquestador. */
const READY_STATUSES = new Set(['on qa', 'on staging', 'on stagging']);

export const canOrchestrate = (status: string): boolean => READY_STATUSES.has(status.trim().toLowerCase());

/** Claves de Jira válidas (AVM-7057). Solo estas llegan a la línea de comandos. */
export const isTicketKey = (key: string): boolean => /^[A-Z][A-Z0-9_]*-\d+$/.test(key);
