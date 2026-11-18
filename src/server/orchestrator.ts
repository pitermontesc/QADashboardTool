import { execFile } from 'node:child_process';
import { ORCHESTRATOR_SKILL, isTicketKey } from '../shared/orchestrator.js';
import { HttpError } from './errors.js';

/** Abre el orquestador para un ticket; inyectable para probar sin abrir Terminal. */
export type OrchestratorLauncher = (key: string) => Promise<void>;

/** Comando que se escribe en Terminal: Claude Code interactivo con el skill y el ticket. */
export function orchestratorCommand(key: string): string {
  if (!isTicketKey(key)) throw new HttpError(400, `Ticket inválido: ${key}`);
  return `claude '${ORCHESTRATOR_SKILL} ${key}'`;
}

/**
 * Abre una ventana nueva de Terminal con Claude Code ejecutando el orquestador.
 * Es interactivo a propósito: el orquestador asigna el ticket y publica en Jira,
 * así que cada paso se puede seguir y aprobar.
 */
export const launchInTerminal: OrchestratorLauncher = (key) => {
  const command = orchestratorCommand(key);
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
