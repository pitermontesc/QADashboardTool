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
 * Instruction appended to Claude's prompt so that, when it finishes, it reports the
 * result to the local API. No single quotes: it goes inside the command line.
 * Written in the app language, since Claude writes the report in the language it is addressed in.
 */
export function reportInstruction(kind: AutomationKind, port: number, id: string, lang: Lang = 'es', reportKey = ''): string {
  // The key proves the result comes from the process this run launched; the server refuses it without the key.
  // It goes in the path, not as ?key=: an unquoted "?" is a glob in zsh and would break Claude's curl.
  const url = `http://127.0.0.1:${port}/api/automation/${id}/result${reportKey ? `/${reportKey}` : ''}`;
  const verdicts = VERDICTS_BY_KIND[kind];
  if (lang === 'en') {
    return (
      ` -- You are running unattended in the background: nobody will answer questions, so decide with the skill's own criteria and keep going, and note any decision you made in details.notes.` +
      ` When you finish, report the result to the QA Dashboard with a JSON POST (header Content-Type: application/json) to ${url}` +
      ` with the fields verdict (${verdicts.slice(0, -1).join(', ')} or BLOCKED; use BLOCKED if it could not be tested, for example no browser or no access), passed, failed, blocked, bugs and minutes (numbers), summary (short summary), link (URL of the report, test run, epic or comment, if any)` +
      ` and details, the full QA report: ${DETAILS_SHAPE}` +
      ` with one module per tested area and every executed step; status is passed, failed, blocked or skipped.` +
      ` If a bug you find is already in Jira (for example, it was found before on another site), put its existing key and link in the bug instead of reporting it as new: the dashboard counts a bug with the same key once.` +
      ` If you write a QA comment for Jira, put it in details.jiraComment (key of the ticket, body in Markdown, posted true only if you published it); if the Jira tool asks for approval or fails, do not try another way: the dashboard publishes it with one click.` +
      ` Write summary and details in English.`
    );
  }
  return (
    ` -- Corres sin supervision en segundo plano: nadie respondera preguntas, asi que decide con el criterio del skill y continua, y anota en details.notes las decisiones que tomaste.` +
    ` Al terminar, reporta el resultado al QA Dashboard con un POST JSON (cabecera Content-Type: application/json) a ${url}` +
    ` con los campos verdict (${verdicts.slice(0, -1).join(', ')} o BLOCKED; usa BLOCKED si no se pudo probar, por ejemplo sin navegador o sin acceso), passed, failed, blocked, bugs y minutes (numeros), summary (resumen corto), link (URL del reporte, test run, epic o comentario, si hay)` +
    ` y details, el reporte QA completo: ${DETAILS_SHAPE}` +
    ` con un modulo por area probada y cada paso ejecutado; status es passed, failed, blocked o skipped.` +
    ` Si un bug que encuentras ya existe en Jira (por ejemplo, se encontro antes en otro sitio), pon su key y su link en el bug en vez de reportarlo como nuevo: el dashboard cuenta una sola vez los bugs con la misma key.` +
    ` Si redactas un comentario de QA para Jira, ponlo en details.jiraComment (key del ticket, body en Markdown, posted true solo si lo publicaste); si la herramienta de Jira pide aprobacion o falla, no lo intentes por otra via: el dashboard lo publica con un clic.` +
    ` Escribe summary y details en espanol.`
  );
}

const RESULT_BY_VERDICT: Record<Verdict, Result> = {
  GO: 'passed',
  'NO-GO': 'failed',
  PASSED: 'passed',
  'PASSED W/F': 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
};

/** Test type of the test run: Smoke, Regression or Functional (orchestrator), per the settings. */
function typeFor(kind: AutomationKind, settings: Settings): string {
  const match =
    kind === 'smoke' ? isSmokeType : kind === 'regression' ? isRegressionType : (name: string) => /funcional|functional/i.test(name);
  return (settings.types.find((t) => match(t.name)) ?? settings.types[0]!).id;
}

const TITLE_TEXT = {
  es: { orchestrator: 'Orquestador QA', withClaude: 'con Claude', testMode: 'modo prueba', running: 'en curso', verdict: 'Veredicto',
    launched: 'Lanzado con Claude Code desde QA Dashboard; el resultado se completa cuando Claude lo reporte.' },
  en: { orchestrator: 'QA orchestrator', withClaude: 'with Claude', testMode: 'test mode', running: 'running', verdict: 'Verdict',
    launched: 'Launched with Claude Code from QA Dashboard; the result is filled in when Claude reports it.' },
} as const;

/** A run's title in the requested language; `subject` is the ticket summary (orchestrator). */
export function automationTitle(kind: AutomationKind, target: string, lang: Lang, subject = '', dryRun = false): string {
  const t = TITLE_TEXT[lang];
  if (kind === 'orchestrator') return `${t.orchestrator}: ${subject}`.slice(0, 250);
  if (kind === 'smoke') return `Smoke ${target} ${t.withClaude}`;
  return `Regression ${target || 'testomat.io'} ${t.withClaude}${dryRun ? ` (${t.testMode})` : ''}`;
}

/** The ticket summary inside an orchestrator title, whatever its language. */
export function titleSubject(title: string): string {
  for (const t of Object.values(TITLE_TEXT)) if (title.startsWith(`${t.orchestrator}: `)) return title.slice(t.orchestrator.length + 2);
  return title;
}

/** A test run's notes allow 5000 characters; verdict + long summary + link can exceed that. */
const NOTES_MAX = 5000;
const clipNotes = (notes: string): string => (notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX - 1)}…` : notes);

/** Title and notes of the test run that reflects the run, in the requested language. */
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
    notes: clipNotes([`${t.verdict} ${automation.verdict}.`, summary, automation.link].filter(Boolean).join('\n')),
  };
}

/**
 * Test run (in Runs) that reflects the run: "In progress" while Claude works, and
 * with the verdict, case counts and summary once it reports.
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
