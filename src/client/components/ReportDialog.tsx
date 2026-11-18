import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityItem, Automation, ReportModule, StepStatus, TestRun } from '../../shared/types';
import { KIND_LABEL, VERDICT_TONE, elapsedMin } from './Automations';
import { Icon } from './icons';
import { useLang, useText } from '../i18n';
import { dateTime } from '../../shared/dates';

interface ReportDialogProps {
  automation: Automation;
  run: TestRun | undefined;
  onClose: () => void;
  onStop: (automation: Automation) => Promise<void>;
}

/** Cada cuánto se refresca la actividad de una ejecución en curso. */
const ACTIVITY_POLL_MS = 4000;

const STATUS_TONE: Record<StepStatus, string> = { passed: 'ok', failed: 'bad', blocked: 'warn', skipped: 'muted' };

const TEXT = {
  es: {
    status: { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'Sin probar' } as Record<StepStatus, string>,
    stepsOk: (done: number, total: number) => `${done}/${total} pasos OK`,
    title: (what: string) => `Reporte QA · ${what}`,
    start: 'Inicio', end: 'Fin', build: 'Build', running: 'En curso', close: 'Cerrar',
    stillRunning: 'Claude está trabajando en segundo plano. El reporte completo aparece aquí en cuanto envíe el resultado.',
    activity: 'Actividad en vivo', waiting: 'Esperando los primeros pasos de Claude…',
    elapsed: (min: number) => `${min} min`, stop: 'Detener', confirmStop: '¿Detener?', stopping: 'Deteniendo…',
    log: 'Log', finalMessage: 'Respuesta final de Claude',
    duration: 'Duración', modules: 'Módulos y pasos',
    noDetails: 'Esta ejecución no envió el detalle de módulos y pasos; solo trae el resumen.',
    bugs: 'Bugs encontrados', openBug: 'Abrir el bug', openBugOf: (key: string) => `Abrir ${key}`,
    bugsNoDetail: (n: number) => `${n} reportados, sin detalle.`, none: 'Ninguno.',
    notes: 'Observaciones', external: 'Abrir reporte externo',
  },
  en: {
    status: { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'Not tested' } as Record<StepStatus, string>,
    stepsOk: (done: number, total: number) => `${done}/${total} steps OK`,
    title: (what: string) => `QA report · ${what}`,
    start: 'Start', end: 'End', build: 'Build', running: 'Running', close: 'Close',
    stillRunning: 'Claude is working in the background. The full report shows up here as soon as it sends the result.',
    activity: 'Live activity', waiting: 'Waiting for Claude’s first steps…',
    elapsed: (min: number) => `${min} min`, stop: 'Stop', confirmStop: 'Stop?', stopping: 'Stopping…',
    log: 'Log', finalMessage: 'Claude’s final answer',
    duration: 'Duration', modules: 'Modules and steps',
    noDetails: 'This run did not send the module and step details; it only has the summary.',
    bugs: 'Bugs found', openBug: 'Open the bug', openBugOf: (key: string) => `Open ${key}`,
    bugsNoDetail: (n: number) => `${n} reported, no details.`, none: 'None.',
    notes: 'Notes', external: 'Open external report',
  },
};
type Text = typeof TEXT.es;

function StatusPill({ status, t }: { status: StepStatus; t: Text }) {
  return (
    <span className={`status-pill tone-${STATUS_TONE[status]}`}>
      <i />
      {t.status[status]}
    </span>
  );
}

function ModuleBlock({ module, t }: { module: ReportModule; t: Text }) {
  const done = module.steps.filter((s) => s.status === 'passed').length;
  return (
    <details className={`rep-module tone-${STATUS_TONE[module.status]}`} open={module.status !== 'passed'}>
      <summary>
        <span className="rep-module-name">{module.name}</span>
        <span className="hint">
          {module.steps.length > 0 && t.stepsOk(done, module.steps.length)}
          {module.minutes !== null && ` · ${module.minutes} min`}
        </span>
        <StatusPill status={module.status} t={t} />
      </summary>
      {module.notes && <p className="rep-notes">{module.notes}</p>}
      {module.steps.length > 0 && (
        <ol className="rep-steps">
          {module.steps.map((step, i) => (
            <li key={i} className={`tone-${STATUS_TONE[step.status]}`}>
              <i aria-hidden="true" />
              <div>
                <span>{step.name}</span>
                {step.notes && <span className="hint">{step.notes}</span>}
              </div>
              <span className="rep-step-status">{t.status[step.status]}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** Reporte QA de una ejecución con Claude: veredicto, tiempos, módulos con sus pasos y bugs encontrados. */
/** Lo que va haciendo Claude: se consulta mientras corre y una última vez al terminar. */
function useActivity(a: Automation): { items: ActivityItem[]; logFile: string } {
  const [activity, setActivity] = useState<{ items: ActivityItem[]; logFile: string }>({ items: [], logFile: a.logFile });
  const running = a.finishedAt === null;
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api.getActivity(a.id).then((next) => alive && setActivity(next)).catch(() => undefined);
    };
    load();
    const timer = running ? setInterval(load, ACTIVITY_POLL_MS) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [a.id, running]);
  return activity;
}

function Activity({ items, t, live }: { items: ActivityItem[]; t: Text; live: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (live) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [items, live]);
  const shown = items.filter((i) => i.kind !== 'start');
  if (shown.length === 0) return <p className="rep-empty">{live ? t.waiting : '—'}</p>;
  return (
    <ol ref={list} className="rep-activity">
      {shown.map((item, i) => (
        <li key={i} className={`act-${item.kind}`}>
          {item.kind === 'tool' ? <Icon name="arrow" size={12} /> : item.kind === 'result' ? <Icon name="check" size={12} /> : <i />}
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function ReportDialog({ automation: a, run, onClose, onStop }: ReportDialogProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const activity = useActivity(a);
  const [stopState, setStopState] = useState<'idle' | 'armed' | 'stopping'>('idle');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const running = a.finishedAt === null;
  const details = a.details;
  const minutes = run?.minutes ?? (a.finishedAt ? Math.max(1, Math.round((a.finishedAt - a.startedAt) / 60_000)) : null);
  const bugCount = details?.bugs.length || run?.bugs || 0;
  const stats = [
    { label: 'Passed', value: run?.passed, tone: 'ok' },
    { label: 'Failed', value: run?.failed, tone: 'bad' },
    { label: 'Blocked', value: run?.blocked, tone: 'warn' },
    { label: 'Bugs', value: bugCount, tone: bugCount ? 'bad' : '' },
    { label: t.duration, value: minutes === null ? null : `${minutes} min`, tone: '' },
  ];

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="report-title" className="report-dialog">
      <div className="report">
        <div className="dialog-head">
          <div>
            <h2 id="report-title">{t.title(`${KIND_LABEL[lang][a.kind]} ${a.target}`)}</h2>
            <p className="hint">
              {a.env} · {t.start} {dateTime(a.startedAt, lang)}
              {a.finishedAt !== null && ` · ${t.end} ${dateTime(a.finishedAt, lang)}`}
              {details?.build && ` · ${t.build} ${details.build}`}
            </p>
          </div>
          {running ? (
            <span className="status-pill tone-prog pulsing"><i />{t.running}</span>
          ) : (
            <span className={`status-pill rep-verdict tone-${a.verdict ? VERDICT_TONE[a.verdict] : 'muted'}`}><i />{a.verdict}</span>
          )}
          <button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {running ? (
          <>
            <div className="rep-live">
              <span className="status-pill tone-prog pulsing"><i />Running · {t.elapsed(elapsedMin(a))}</span>
              <span className="hint">{t.stillRunning}</span>
              <div className="spacer" />
              <button
                className="btn small danger"
                disabled={stopState === 'stopping'}
                onClick={() => {
                  if (stopState === 'armed') {
                    setStopState('stopping');
                    void onStop(a);
                  } else setStopState('armed');
                }}
              >
                {stopState === 'stopping' ? t.stopping : stopState === 'armed' ? t.confirmStop : t.stop}
              </button>
            </div>
            <h3 className="rep-h">{t.activity}</h3>
            <Activity items={activity.items} t={t} live />
          </>
        ) : (
          <>
            <div className="rep-stats">
              {stats.map((s) => (
                <div key={s.label} className={s.tone ? `tone-${s.tone}` : ''}>
                  <b>{s.value ?? '—'}</b>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>

            {a.summary && <p className="rep-summary">{a.summary}</p>}

            <h3 className="rep-h">{t.modules} {details && details.modules.length > 0 && <span className="hint">({details.modules.length})</span>}</h3>
            {details && details.modules.length > 0 ? (
              <div className="rep-modules">
                {details.modules.map((m, i) => <ModuleBlock key={i} module={m} t={t} />)}
              </div>
            ) : (
              <p className="rep-empty">{t.noDetails}</p>
            )}

            <h3 className="rep-h">{t.bugs} <span className="hint">({bugCount})</span></h3>
            {details && details.bugs.length > 0 ? (
              <ul className="rep-bugs">
                {details.bugs.map((b, i) => (
                  <li key={i}>
                    {b.severity && <span className="rep-sev">{b.severity}</span>}
                    <div>
                      <span>
                        {b.key && <b>{b.key} · </b>}
                        {b.title}
                      </span>
                      {b.module && <span className="hint">{b.module}</span>}
                    </div>
                    {b.link && (
                      <a className="icon-btn" href={b.link} target="_blank" rel="noopener noreferrer" aria-label={b.key ? t.openBugOf(b.key) : t.openBug} title={t.openBug}>
                        <Icon name="external" size={14} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rep-empty">{bugCount ? t.bugsNoDetail(bugCount) : t.none}</p>
            )}

            {details?.notes && (
              <>
                <h3 className="rep-h">{t.notes}</h3>
                <p className="rep-notes">{details.notes}</p>
              </>
            )}

            {activity.items.some((i) => i.kind !== 'start') && (
              <details className="rep-log">
                <summary>{t.activity} · {t.log}</summary>
                <Activity items={activity.items} t={t} live={false} />
                {activity.logFile && <p className="hint"><code>{activity.logFile}</code></p>}
              </details>
            )}
          </>
        )}

        <div className="actions">
          <div className="spacer" />
          {a.link && (
            <a className="btn" href={a.link} target="_blank" rel="noopener noreferrer">
              <Icon name="external" /> {t.external}
            </a>
          )}
          <button type="button" className="btn primary" onClick={onClose}>{t.close}</button>
        </div>
      </div>
    </dialog>
  );
}
