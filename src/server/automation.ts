import { isRegressionType, isSmokeType } from '../shared/orchestrator.js';
import { toYmd } from '../shared/dates.js';
import type { Automation, AutomationKind, Result, Settings, TestRunInput, Verdict } from '../shared/types.js';
import type { AutomationResult } from './schemas.js';

const VERDICT_HINT: Record<AutomationKind, string> = {
  smoke: 'GO, NO-GO o BLOCKED',
  regression: 'GO, NO-GO o BLOCKED',
  orchestrator: 'PASSED, PASSED W/F, FAILED o BLOCKED',
};

/**
 * Instrucción que se añade al prompt de Claude para que, al terminar, reporte el
 * resultado a la API local. Sin comillas simples: va dentro de la línea de comandos.
 */
export function reportInstruction(kind: AutomationKind, port: number, id: string): string {
  return (
    ` -- Al terminar, reporta el resultado al QA Dashboard con un POST JSON a http://127.0.0.1:${port}/api/automation/${id}/result` +
    ` con los campos verdict (${VERDICT_HINT[kind]}; usa BLOCKED si no se pudo probar, por ejemplo sin navegador o sin acceso), passed, failed, blocked, bugs y minutes (numeros), summary (resumen corto) y link (URL del reporte, test run, epic o comentario, si hay).`
  );
}

/** Ambiente de los ajustes que corresponde al sitio probado (QA o Staging). */
export function envFor(target: 'qa' | 'staging', settings: Settings): string {
  const match = settings.envs.find((env) => env.toLowerCase().startsWith(target === 'qa' ? 'qa' : 'stag'));
  return match ?? (target === 'qa' ? 'QA' : 'Staging');
}

const RESULT_BY_VERDICT: Record<Verdict, Result> = {
  GO: 'passed',
  'NO-GO': 'failed',
  PASSED: 'passed',
  'PASSED W/F': 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
};

/** Tipo de test del registro: Smoke, Regression o Funcional (orquestador), según los ajustes. */
function typeFor(kind: AutomationKind, settings: Settings): string {
  const match =
    kind === 'smoke' ? isSmokeType : kind === 'regression' ? isRegressionType : (name: string) => /funcional/i.test(name);
  return (settings.types.find((t) => match(t.name)) ?? settings.types[0]!).id;
}

/**
 * Registro de Registros que refleja la ejecución: «En progreso» mientras Claude
 * trabaja y con el veredicto, los casos y el resumen cuando lo reporta.
 */
export function runForAutomation(automation: Automation, settings: Settings, result?: AutomationResult): TestRunInput {
  const base = {
    date: toYmd(new Date(automation.startedAt)),
    typeId: typeFor(automation.kind, settings),
    ticket: automation.kind === 'orchestrator' ? automation.target : '',
    env: automation.env,
  };
  if (!result) {
    return {
      ...base,
      title: `${automation.title} · en curso`,
      result: 'progress',
      passed: null, failed: null, blocked: null, bugs: null, minutes: null,
      notes: 'Lanzado con Claude Code desde QA Dashboard; el resultado se completa cuando Claude lo reporte.',
    };
  }
  return {
    ...base,
    title: `${automation.title} · ${result.verdict}`,
    result: RESULT_BY_VERDICT[result.verdict],
    passed: result.passed,
    failed: result.failed,
    blocked: result.blocked,
    bugs: result.bugs,
    minutes: result.minutes ?? Math.max(1, Math.round((Date.now() - automation.startedAt) / 60_000)),
    notes: [`Veredicto ${result.verdict}.`, result.summary, result.link].filter(Boolean).join('\n'),
  };
}
