import { isRegressionType, isSmokeType } from '../shared/orchestrator.js';
import { toYmd } from '../shared/dates.js';
import type { Automation, AutomationKind, Lang, Result, Settings, TestRunInput, Verdict } from '../shared/types.js';
import type { AutomationResult } from './schemas.js';

export const VERDICTS_BY_KIND: Record<AutomationKind, Verdict[]> = {
  smoke: ['GO', 'NO-GO', 'BLOCKED'],
  regression: ['GO', 'NO-GO', 'BLOCKED'],
  orchestrator: ['PASSED', 'PASSED W/F', 'FAILED', 'BLOCKED'],
};
const DETAILS_SHAPE =
  '{build, notes, modules: [{name, status, minutes, notes, steps: [{name, status, notes}]}], bugs: [{title, severity, key, link, module}], jiraComment: {key, body, posted}}';

/**
 * Instrucción que se añade al prompt de Claude para que, al terminar, reporte el
 * resultado a la API local. Sin comillas simples: va dentro de la línea de comandos.
 */
export function reportInstruction(kind: AutomationKind, port: number, id: string, lang: Lang = 'es'): string {
  const url = `http://127.0.0.1:${port}/api/automation/${id}/result`;
  const verdicts = VERDICTS_BY_KIND[kind];
  if (lang === 'en') {
    return (
      ` -- You are running unattended in the background: nobody will answer questions, so decide with the skill's own criteria and keep going, and note any decision you made in details.notes.` +
      ` When you finish, report the result to the QA Dashboard with a JSON POST to ${url}` +
      ` with the fields verdict (${verdicts.slice(0, -1).join(', ')} or BLOCKED; use BLOCKED if it could not be tested, for example no browser or no access), passed, failed, blocked, bugs and minutes (numbers), summary (short summary), link (URL of the report, test run, epic or comment, if any)` +
      ` and details, the full QA report: ${DETAILS_SHAPE}` +
      ` with one module per tested area and every executed step; status is passed, failed, blocked or skipped.` +
      ` If you write a QA comment for Jira, put it in details.jiraComment (key of the ticket, body in Markdown, posted true only if you published it); if the Jira tool asks for approval or fails, do not try another way: the dashboard publishes it with one click.` +
      ` Write summary and details in English.`
    );
  }
  return (
    ` -- Corres sin supervision en segundo plano: nadie respondera preguntas, asi que decide con el criterio del skill y continua, y anota en details.notes las decisiones que tomaste.` +
    ` Al terminar, reporta el resultado al QA Dashboard con un POST JSON a ${url}` +
    ` con los campos verdict (${verdicts.slice(0, -1).join(', ')} o BLOCKED; usa BLOCKED si no se pudo probar, por ejemplo sin navegador o sin acceso), passed, failed, blocked, bugs y minutes (numeros), summary (resumen corto), link (URL del reporte, test run, epic o comentario, si hay)` +
    ` y details, el reporte QA completo: ${DETAILS_SHAPE}` +
    ` con un modulo por area probada y cada paso ejecutado; status es passed, failed, blocked o skipped.` +
    ` Si redactas un comentario de QA para Jira, ponlo en details.jiraComment (key del ticket, body en Markdown, posted true solo si lo publicaste); si la herramienta de Jira pide aprobacion o falla, no lo intentes por otra via: el dashboard lo publica con un clic.` +
    ` Escribe summary y details en espanol.`
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
    kind === 'smoke' ? isSmokeType : kind === 'regression' ? isRegressionType : (name: string) => /funcional|functional/i.test(name);
  return (settings.types.find((t) => match(t.name)) ?? settings.types[0]!).id;
}

const TITLE_TEXT = {
  es: { orchestrator: 'Orquestador QA', withClaude: 'con Claude', running: 'en curso', verdict: 'Veredicto',
    launched: 'Lanzado con Claude Code desde QA Dashboard; el resultado se completa cuando Claude lo reporte.' },
  en: { orchestrator: 'QA orchestrator', withClaude: 'with Claude', running: 'running', verdict: 'Verdict',
    launched: 'Launched with Claude Code from QA Dashboard; the result is filled in when Claude reports it.' },
} as const;

/** Título de una ejecución en el idioma pedido; `subject` es el resumen del ticket (orquestador). */
export function automationTitle(kind: AutomationKind, target: string, lang: Lang, subject = ''): string {
  const t = TITLE_TEXT[lang];
  if (kind === 'orchestrator') return `${t.orchestrator}: ${subject}`.slice(0, 250);
  return kind === 'smoke' ? `Smoke ${target} ${t.withClaude}` : `Regression ${target || 'testomat.io'} ${t.withClaude}`;
}

/** Resumen del ticket dentro del título de un orquestador, sea cual sea su idioma. */
export function titleSubject(title: string): string {
  for (const t of Object.values(TITLE_TEXT)) if (title.startsWith(`${t.orchestrator}: `)) return title.slice(t.orchestrator.length + 2);
  return title;
}

/** Título y notas del registro que refleja la ejecución, en el idioma pedido. */
export function runText(
  automation: Pick<Automation, 'title' | 'verdict' | 'link'>,
  lang: Lang,
  summary: string,
  finished: boolean,
): { title: string; notes: string } {
  const t = TITLE_TEXT[lang];
  if (!finished) return { title: `${automation.title} · ${t.running}`, notes: t.launched };
  return {
    title: `${automation.title} · ${automation.verdict}`,
    notes: [`${t.verdict} ${automation.verdict}.`, summary, automation.link].filter(Boolean).join('\n'),
  };
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
      ...runText(automation, settings.language, '', false),
      result: 'progress',
      passed: null, failed: null, blocked: null, bugs: null, minutes: null,
    };
  }
  return {
    ...base,
    ...runText({ title: automation.title, verdict: result.verdict, link: result.link }, settings.language, result.summary, true),
    result: RESULT_BY_VERDICT[result.verdict],
    passed: result.passed,
    failed: result.failed,
    blocked: result.blocked,
    bugs: result.bugs,
    minutes: result.minutes ?? Math.max(1, Math.round((Date.now() - automation.startedAt) / 60_000)),
  };
}
