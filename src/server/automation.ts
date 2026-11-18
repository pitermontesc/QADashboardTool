import { isRegressionType, isSmokeType } from '../shared/orchestrator.js';
import { toYmd } from '../shared/dates.js';
import type { Automation, Settings, TestRunInput } from '../shared/types.js';
import type { AutomationResult } from './schemas.js';

/**
 * Instrucción que se añade al prompt de Claude para que, al terminar, reporte el
 * resultado a la API local. Sin comillas simples: va dentro de la línea de comandos.
 */
export function reportInstruction(port: number, id: string): string {
  return (
    ` -- Al terminar, reporta el resultado al QA Dashboard con un POST JSON a http://127.0.0.1:${port}/api/automation/${id}/result` +
    ' con los campos verdict (GO o NO-GO), passed, failed, blocked, bugs y minutes (numeros), summary (resumen corto) y link (URL del reporte, test run o epic, si hay).'
  );
}

/** Ambiente de los ajustes que corresponde al sitio probado (QA o Staging). */
export function envFor(target: 'qa' | 'staging', settings: Settings): string {
  const match = settings.envs.find((env) => env.toLowerCase().startsWith(target === 'qa' ? 'qa' : 'stag'));
  return match ?? (target === 'qa' ? 'QA' : 'Staging');
}

/** Registro del dashboard que refleja el resultado reportado por Claude. */
export function runFromResult(automation: Automation, result: AutomationResult, settings: Settings): TestRunInput {
  const isType = automation.kind === 'smoke' ? isSmokeType : isRegressionType;
  const type = settings.types.find((t) => isType(t.name)) ?? settings.types[0]!;
  const what = automation.kind === 'smoke' ? `Smoke ${automation.target}` : `Regression ${automation.target || 'testomat.io'}`;
  return {
    date: toYmd(new Date()),
    typeId: type.id,
    title: `${what} con Claude · ${result.verdict}`,
    ticket: '',
    env: automation.env,
    result: result.verdict === 'GO' ? 'passed' : 'failed',
    passed: result.passed,
    failed: result.failed,
    blocked: result.blocked,
    bugs: result.bugs,
    minutes: result.minutes ?? Math.max(1, Math.round((Date.now() - automation.startedAt) / 60_000)),
    notes: [`Veredicto ${result.verdict}.`, result.summary, result.link].filter(Boolean).join('\n'),
  };
}
