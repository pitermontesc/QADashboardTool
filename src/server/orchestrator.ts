import { execFile } from 'node:child_process';
import { ORCHESTRATOR_SKILL, REGRESSION_SKILL, SMOKE_SITES, SMOKE_SKILL, isSmokeSite, isTestRunRef, isTicketKey } from '../shared/orchestrator.js';
import { HttpError } from './errors.js';

/** Ejecuta un comando en una ventana nueva de Terminal; inyectable para probar sin abrirla. */
export type TerminalLauncher = (command: string) => Promise<void>;

/** `claude '<prompt>'`: el prompt va entre comillas simples, así que no puede contenerlas. */
function claude(prompt: string): string {
  if (prompt.includes("'")) throw new HttpError(400, 'El prompt no puede contener comillas simples');
  return `claude '${prompt}'`;
}

/** Claude Code interactivo con el orquestador sobre un ticket. */
export function orchestratorCommand(key: string, extra = ''): string {
  if (!isTicketKey(key)) throw new HttpError(400, `Ticket inválido: ${key}`);
  return claude(`${ORCHESTRATOR_SKILL} ${key}${extra}`);
}

/** Claude Code interactivo con el runner de regresión; sin test run, el skill lo pregunta. */
export function regressionCommand(run: string, extra = ''): string {
  if (!isTestRunRef(run)) throw new HttpError(400, 'Test run inválido: pega el link de testomat.io o su ID (p. ej. #b333fb92)');
  return claude(`${run ? `${REGRESSION_SKILL} ${run}` : REGRESSION_SKILL}${extra}`);
}

/** Claude Code interactivo con el smoke tester sobre el sitio elegido (QA o STG). */
export function smokeCommand(site: unknown, extra = ''): string {
  if (!isSmokeSite(site)) throw new HttpError(400, 'Elige el sitio del smoke: QA o STG');
  const { label, url } = SMOKE_SITES[site];
  return claude(`${SMOKE_SKILL} run smoke on ${label} (${url})${extra}`);
}

/**
 * Abre una ventana nueva de Terminal con el comando. Es interactivo a propósito:
 * los skills de QA publican en Jira y testomat.io, así que cada paso se sigue y aprueba.
 */
export const launchInTerminal: TerminalLauncher = (command) => {
  if (process.platform !== 'darwin') {
    return Promise.reject(new HttpError(501, `Abre una terminal y ejecuta: ${command}`));
  }
  // El comando va como argumento de AppleScript, nunca interpolado en el script.
  const script = ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run'];
  return new Promise((resolve, reject) => {
    execFile('osascript', [...script.flatMap((line) => ['-e', line]), command], (err) => {
      if (err) reject(new HttpError(500, `No se pudo abrir Terminal: ${err.message}`));
      else resolve();
    });
  });
};
