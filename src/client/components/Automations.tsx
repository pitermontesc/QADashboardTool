import { relativeTime } from '../../shared/dates';
import type { Automation, AutomationKind, TestRun, Verdict } from '../../shared/types';
import { Icon } from './icons';

interface AutomationsProps {
  automations: Automation[];
  runs: TestRun[];
  onDismiss: (automation: Automation) => void;
}

/** Tras este tiempo sin reporte se asume que Claude no llegó a reportar. */
const STALE_MS = 12 * 60 * 60_000;
const SHOWN = 6;

const KIND_LABEL: Record<AutomationKind, string> = { smoke: 'Smoke', regression: 'Regression', orchestrator: 'Orquestador' };

const VERDICT_TONE: Record<Verdict, string> = {
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
export function Automations({ automations, runs, onDismiss }: AutomationsProps) {
  if (automations.length === 0) return null;
  const now = Date.now();
  const byId = new Map(runs.map((r) => [r.id, r]));

  return (
    <div className="card automations">
      <div className="card-head">
        <div>
          <h3 className="title">Ejecuciones con Claude</h3>
          <div className="card-sub">
            <span className="hint">Cada ejecución aparece en Registros al lanzarla y se completa cuando Claude reporta el veredicto.</span>
          </div>
        </div>
      </div>
      <ul className="auto-list">
        {automations.slice(0, SHOWN).map((a) => {
          const running = a.finishedAt === null;
          const stale = running && now - a.startedAt > STALE_MS;
          const run = a.runId ? byId.get(a.runId) : undefined;
          return (
            <li key={a.id} className="auto-row">
              <span className={`auto-kind kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
              <span className="auto-target">
                <b title={a.title}>{a.target || 'testomat.io'}</b>
                <span className="hint">{a.env}</span>
              </span>
              {running ? (
                <span className={`status-pill ${stale ? 'tone-muted' : 'tone-prog pulsing'}`}>
                  <i />
                  {stale ? 'Sin resultado' : 'En curso'}
                </span>
              ) : (
                <span className={`status-pill tone-${a.verdict ? VERDICT_TONE[a.verdict] : 'muted'}`}>
                  <i />
                  {a.verdict}
                </span>
              )}
              <span className="auto-detail">
                {running ? (
                  <span className="hint">Lanzado {relativeTime(a.startedAt, now)}</span>
                ) : (
                  <>
                    {counts(run) && <span>{counts(run)}</span>}
                    {a.summary && <span className="hint auto-summary" title={a.summary}>{a.summary}</span>}
                    <span className="hint">{relativeTime(a.finishedAt!, now)}</span>
                  </>
                )}
              </span>
              <span className="auto-actions">
                {a.link && (
                  <a className="icon-btn" href={a.link} target="_blank" rel="noopener noreferrer" title="Abrir el reporte" aria-label="Abrir el reporte">
                    <Icon name="external" size={14} />
                  </a>
                )}
                {running && (
                  <button className="icon-btn" onClick={() => onDismiss(a)} title="Descartar esta ejecución" aria-label="Descartar esta ejecución">
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
