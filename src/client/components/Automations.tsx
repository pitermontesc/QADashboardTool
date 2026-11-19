import { relativeTime } from '../../shared/dates';
import type { Automation, AutomationKind, Lang, TestRun, Verdict } from '../../shared/types';
import { Icon } from './icons';
import { useLang, useText } from '../i18n';

interface AutomationsProps {
  automations: Automation[];
  runs: TestRun[];
  onDismiss: (automation: Automation) => void;
  onOpen: (automation: Automation) => void;
}

/** Ejecución en curso de ese tipo (y objetivo, si se indica): para marcar «Running» en el dashboard. */
export function runningOf(automations: Automation[], kind: AutomationKind, target?: string): Automation | undefined {
  return automations.find((a) => a.finishedAt === null && a.kind === kind && (target === undefined || a.target === target));
}

/**
 * Resumen y reporte de una ejecución en el idioma de la app: el original si Claude lo
 * escribió en ese idioma, o su traducción. `pending` indica que aún falta traducirlo.
 */
export function reportIn(a: Automation, lang: Lang): { summary: string; details: Automation['details']; pending: boolean } {
  if (a.lang === lang || a.finishedAt === null) return { summary: a.summary, details: a.details, pending: false };
  const translation = a.translations[lang];
  if (!translation) return { summary: a.summary, details: a.details, pending: a.summary !== '' || a.details !== null };
  // El comentario de Jira no se traduce: siempre el original.
  const details = translation.details && a.details ? { ...translation.details, jiraComment: a.details.jiraComment } : a.details;
  return { summary: translation.summary || a.summary, details, pending: false };
}

/** Minutos desde que empezó, para «Running · 5 min». */
export const elapsedMin = (a: Automation, now = Date.now()): number => Math.max(0, Math.floor((now - a.startedAt) / 60_000));

/** Tras este tiempo sin reporte se asume que Claude no llegó a reportar. */
const STALE_MS = 12 * 60 * 60_000;
const SHOWN = 6;

export const KIND_LABEL: Record<Lang, Record<AutomationKind, string>> = {
  es: { smoke: 'Smoke', regression: 'Regression', orchestrator: 'Orquestador' },
  en: { smoke: 'Smoke', regression: 'Regression', orchestrator: 'Orchestrator' },
};

const TEXT = {
  es: {
    title: 'Ejecuciones de QA automatizadas',
    sub: 'Smoke, regresión y validación de tickets que corren solas con Claude. Cada una aparece en Registros al lanzarla y se completa con su veredicto. Pulsa una para ver su reporte QA.',
    stale: 'Sin resultado', running: 'Running', launched: (min: number) => `Corriendo en segundo plano · ${min} min`,
    viewReport: 'Ver el reporte QA', viewReportOf: (what: string) => `Ver el reporte QA de ${what}`,
    openLink: 'Abrir el reporte', dismiss: 'Detener y descartar esta ejecución',
  },
  en: {
    title: 'Automated QA runs',
    sub: 'Smoke tests, regressions and ticket validations that Claude runs on its own. Each one shows up in Runs when launched and is completed with its verdict. Click one to see its QA report.',
    stale: 'No result', running: 'Running', launched: (min: number) => `Running in the background · ${min} min`,
    viewReport: 'View QA report', viewReportOf: (what: string) => `View QA report for ${what}`,
    openLink: 'Open the report', dismiss: 'Stop and dismiss this run',
  },
};

export const VERDICT_TONE: Record<Verdict, string> = {
  GO: 'ok', PASSED: 'ok', 'PASSED W/F': 'warn', BLOCKED: 'warn', 'NO-GO': 'bad', FAILED: 'bad',
};

function counts(run: TestRun | undefined): string {
  if (!run) return '';
  const parts = [
    run.passed !== null && `${run.passed} passed`,
    run.failed ? `${run.failed} failed` : false,
    run.blocked ? `${run.blocked} blocked` : false,
    run.bugs ? `${run.bugs} ${run.bugs === 1 ? 'bug' : 'bugs'}` : false,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Ejecuciones lanzadas con Claude (smoke, regresión, orquestador): en curso y con su veredicto. */
export function Automations({ automations, runs, onDismiss, onOpen }: AutomationsProps) {
  const lang = useLang();
  const t = useText(TEXT);
  if (automations.length === 0) return null;
  const now = Date.now();
  const byId = new Map(runs.map((r) => [r.id, r]));

  return (
    <div className="card automations">
      <div className="card-head">
        <div>
          <h3 className="title">{t.title}</h3>
          <div className="card-sub">
            <span className="hint">{t.sub}</span>
          </div>
        </div>
      </div>
      <ul className="auto-list">
        {automations.slice(0, SHOWN).map((a) => {
          const running = a.finishedAt === null;
          const stale = running && now - a.startedAt > STALE_MS;
          const run = a.runId ? byId.get(a.runId) : undefined;
          return (
            <li key={a.id} className="auto-row" onClick={() => onOpen(a)} title={t.viewReport}>
              <span className={`auto-kind kind-${a.kind}`}>{KIND_LABEL[lang][a.kind]}</span>
              <span className="auto-target">
                <b title={a.title}>{a.target || 'testomat.io'}</b>
                <span className="hint">{a.env}</span>
              </span>
              {running ? (
                <span className={`status-pill ${stale ? 'tone-muted' : 'tone-prog pulsing'}`}>
                  <i />
                  {stale ? t.stale : t.running}
                </span>
              ) : (
                <span className={`status-pill tone-${a.verdict ? VERDICT_TONE[a.verdict] : 'muted'}`}>
                  <i />
                  {a.verdict}
                </span>
              )}
              <span className="auto-detail">
                {running ? (
                  <span className="hint">{t.launched(elapsedMin(a, now))}</span>
                ) : (
                  <>
                    {counts(run) && <span>{counts(run)}</span>}
                    {(() => {
                      const { summary } = reportIn(a, lang);
                      return summary && <span className="hint auto-summary" title={summary}>{summary}</span>;
                    })()}
                    <span className="hint">{relativeTime(a.finishedAt!, now, lang)}</span>
                  </>
                )}
              </span>
              <span className="auto-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" onClick={() => onOpen(a)} title={t.viewReport} aria-label={t.viewReportOf(`${KIND_LABEL[lang][a.kind]} ${a.target}`)}>
                  <Icon name="eye" size={14} />
                </button>
                {a.link && (
                  <a className="icon-btn" href={a.link} target="_blank" rel="noopener noreferrer" title={t.openLink} aria-label={t.openLink}>
                    <Icon name="external" size={14} />
                  </a>
                )}
                {running && (
                  <button className="icon-btn" onClick={() => onDismiss(a)} title={t.dismiss} aria-label={t.dismiss}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
