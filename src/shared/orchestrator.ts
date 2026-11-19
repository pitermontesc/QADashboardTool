import type { QaConfig, QaSite } from './types.js';

/**
 * Configuración de QA por defecto: los sitios donde se prueba, los skills de Claude
 * Code y los estados de Jira listos para el orquestador. Todo se edita en
 * Tipos y ajustes → Sitios y skills; estos valores solo se usan si no hay otros guardados.
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

/** Sitio donde se prueba un ticket según su estado de Jira; ninguno si no está listo para el orquestador. */
export const siteForStatus = (status: string, qa: QaConfig): QaSite | undefined =>
  qa.sites.find((site) => site.jiraStatus.trim() !== '' && sameStatus(site.jiraStatus, status));

export const canOrchestrate = (status: string, qa: QaConfig): boolean => siteForStatus(status, qa) !== undefined;

/** Estados de Jira listos para el orquestador, para mostrarlos («On QA u On Staging»). */
export const readyStatuses = (qa: QaConfig): string[] => qa.sites.map((s) => s.jiraStatus).filter((s) => s.trim() !== '');

export const findSite = (id: unknown, qa: QaConfig): QaSite | undefined =>
  typeof id === 'string' ? qa.sites.find((site) => site.id === id) : undefined;

/** Claves de Jira válidas (AVM-7057). Solo estas llegan a la línea de comandos. */
export const isTicketKey = (key: string): boolean => /^[A-Z][A-Z0-9_]*-\d+$/.test(key);

/** Suites a las que se ofrece el runner de regresión. */
export const isRegressionType = (name: string): boolean => /regres/i.test(name);

/** Suites a las que se ofrece el smoke tester. */
export const isSmokeType = (name: string): boolean => /smoke/i.test(name);

/**
 * Test run: vacío (el skill lo pide), un ID como `#b333fb92` o un link https de uno
 * de los dominios configurados (o sus subdominios). Sin comillas ni espacios.
 */
export function isTestRunRef(ref: string, hosts: readonly string[]): boolean {
  if (ref === '') return true;
  if (/^#?[A-Za-z0-9-]{4,64}$/.test(ref)) return true;
  if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9\-._~/?=&#%:+]*$/.test(ref)) return false;
  const host = new URL(ref).hostname;
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
