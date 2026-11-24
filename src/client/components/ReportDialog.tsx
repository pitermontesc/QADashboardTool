import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityItem, Automation, JiraComment, ReportBug, ReportBugEdit, ReportModule, StepStatus, TestRun } from '../../shared/types';
import { KIND_LABEL, VERDICT_TONE, elapsedMin, reportIn } from './Automations';
import { Icon } from './icons';
import { useModalDialog } from './ui';
import { useLang, useText } from '../i18n';
import { dateTime, shortLabel } from '../../shared/dates';

interface ReportDialogProps {
  automation: Automation;
  run: TestRun | undefined;
  /** Every run, to show which other reports list the same Jira bug. */
  automations: Automation[];
  onClose: () => void;
  /** Resolves false if the run could not be stopped (then the button can be used again). */
  onStop: (automation: Automation) => Promise<boolean>;
  /** The automation changed (translation or posted comment). */
  onUpdate: (automation: Automation) => void;
  onError: (error: unknown) => void;
}

/** How often the activity of a running automation is refreshed. */
const ACTIVITY_POLL_MS = 4000;

const STATUS_TONE: Record<StepStatus, string> = { passed: 'ok', failed: 'bad', blocked: 'warn', skipped: 'muted' };

const TEXT = {
  es: {
    status: { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'Sin probar' } as Record<StepStatus, string>,
    stepsOk: (done: number, total: number) => `${done}/${total} pasos OK`,
    title: (what: string) => `Reporte QA · ${what}`,
    start: 'Inicio', end: 'Fin', build: 'Build', running: 'En curso', close: 'Cerrar',
    dryRun: 'Modo prueba: sin crear ni marcar nada en Jira ni en testomat.io',
    stillRunning: 'Claude está trabajando en segundo plano. El reporte completo aparece aquí en cuanto envíe el resultado.',
    activity: 'Actividad en vivo', waiting: 'Esperando los primeros pasos de Claude…',
    elapsed: (min: number) => `${min} min`, stop: 'Detener', confirmStop: '¿Detener?', stopping: 'Deteniendo…',
    log: 'Log', finalMessage: 'Respuesta final de Claude',
    duration: 'Duración', modules: 'Módulos y pasos',
    noDetails: 'Esta ejecución no envió el detalle de módulos y pasos; solo trae el resumen.',
    bugs: 'Bugs encontrados', openBug: 'Abrir el bug', openBugOf: (key: string) => `Abrir ${key}`,
    bugsNoDetail: (n: number) => (n === 1 ? '1 reportado, sin detalle.' : `${n} reportados, sin detalle.`), none: 'Ninguno.',
    notes: 'Observaciones', external: 'Abrir reporte externo',
    translating: 'Traduciendo el reporte al español con Claude… Mientras tanto se muestra el original.',
    translateFailed: 'No se pudo traducir el reporte; se muestra el original.', retry: 'Reintentar',
    jira: (key: string) => `Comentario de QA para ${key}`,
    jiraPending: 'Claude no pudo publicarlo en Jira. Revísalo (puedes editarlo) y publícalo con tu cuenta de Jira.',
    jiraPosted: 'Publicado en Jira.', jiraPostedByClaude: 'Claude ya lo publicó en Jira.', openComment: 'Ver en Jira',
    publish: (key: string) => `Publicar en ${key}`, publishing: 'Publicando…', confirmPublish: (key: string) => `¿Publicar en ${key}?`,
    copy: 'Copiar', copied: 'Copiado',
    dismiss: 'Ya publicado / Descartar', confirmDismiss: '¿Descartar? No se publicará',
    dismissed: 'Descartado: la app no lo publicará (por ejemplo, porque ya se publicó otro comentario en el ticket).', restore: 'Recuperar',
    editBugs: 'Editar', bugKey: 'Clave de Jira', severity: 'Severidad', module: 'Módulo', bugTitle: 'Título', link: 'Link',
    linkPh: 'Vacío: se arma con la clave y tu sitio de Jira', addBug: 'Agregar bug', cancel: 'Cancelar', save: 'Guardar bugs', saving: 'Guardando…',
    removeBug: (n: number) => `Quitar el bug ${n}`, needsTitle: 'Cada bug necesita un título.',
    alsoIn: (where: string) => `También en ${where}: cuenta una sola vez en el dashboard`,
  },
  en: {
    status: { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', skipped: 'Not tested' } as Record<StepStatus, string>,
    stepsOk: (done: number, total: number) => `${done}/${total} steps OK`,
    title: (what: string) => `QA report · ${what}`,
    start: 'Start', end: 'End', build: 'Build', running: 'Running', close: 'Close',
    dryRun: 'Test mode: nothing is created or marked in Jira or testomat.io',
    stillRunning: 'Claude is working in the background. The full report shows up here as soon as it sends the result.',
    activity: 'Live activity', waiting: 'Waiting for Claude’s first steps…',
    elapsed: (min: number) => `${min} min`, stop: 'Stop', confirmStop: 'Stop?', stopping: 'Stopping…',
    log: 'Log', finalMessage: 'Claude’s final answer',
    duration: 'Duration', modules: 'Modules and steps',
    noDetails: 'This run did not send the module and step details; it only has the summary.',
    bugs: 'Bugs found', openBug: 'Open the bug', openBugOf: (key: string) => `Open ${key}`,
    bugsNoDetail: (n: number) => `${n} reported, no details.`, none: 'None.',
    notes: 'Notes', external: 'Open external report',
    translating: 'Translating the report into English with Claude… The original is shown meanwhile.',
    translateFailed: 'Could not translate the report; the original is shown.', retry: 'Retry',
    jira: (key: string) => `QA comment for ${key}`,
    jiraPending: 'Claude could not post it on Jira. Review it (you can edit it) and post it with your Jira account.',
    jiraPosted: 'Posted on Jira.', jiraPostedByClaude: 'Claude already posted it on Jira.', openComment: 'View on Jira',
    publish: (key: string) => `Post on ${key}`, publishing: 'Posting…', confirmPublish: (key: string) => `Post on ${key}?`,
    copy: 'Copy', copied: 'Copied',
    dismiss: 'Already posted / Dismiss', confirmDismiss: 'Dismiss? It will not be posted',
    dismissed: 'Dismissed: the app will not post it (for example, because another comment was already posted on the ticket).', restore: 'Restore',
    editBugs: 'Edit', bugKey: 'Jira key', severity: 'Severity', module: 'Module', bugTitle: 'Title', link: 'Link',
    linkPh: 'Empty: built from the key and your Jira site', addBug: 'Add bug', cancel: 'Cancel', save: 'Save bugs', saving: 'Saving…',
    removeBug: (n: number) => `Remove bug ${n}`, needsTitle: 'Each bug needs a title.',
    alsoIn: (where: string) => `Also in ${where}: counted once on the dashboard`,
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

/** What Claude is doing: polled while it runs and once more when it finishes. */
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

/** QA comment for Jira: can be reviewed, edited, copied and posted with one click. */
function JiraCommentBlock({ automation, comment, t, onUpdate, onError }: {
  automation: Automation; comment: JiraComment; t: Text; onUpdate: (a: Automation) => void; onError: (e: unknown) => void;
}) {
  const [body, setBody] = useState(comment.body);
  const [state, setState] = useState<'idle' | 'armed' | 'posting'>('idle');
  const [dismissArmed, setDismissArmed] = useState(false);
  const setDismissed = async (dismissed: boolean): Promise<void> => {
    if (dismissed && !dismissArmed) {
      setDismissArmed(true);
      return;
    }
    setDismissArmed(false);
    try {
      onUpdate(await api.dismissJiraComment(automation.id, dismissed));
    } catch (error) {
      onError(error);
    }
  };
  const [copied, setCopied] = useState(false);
  const publish = async (): Promise<void> => {
    if (state !== 'armed') {
      setState('armed');
      return;
    }
    setState('posting');
    try {
      onUpdate(await api.postJiraComment(automation.id, body));
    } catch (error) {
      onError(error);
    }
    setState('idle');
  };
  return (
    <>
      <h3 className="rep-h">{t.jira(comment.key)}</h3>
      <div className={`rep-jira${comment.posted || comment.dismissed ? ' posted' : ''}`}>
        <p className="hint">
          {comment.posted ? (comment.url ? t.jiraPosted : t.jiraPostedByClaude) : comment.dismissed ? t.dismissed : t.jiraPending}
          {comment.url && (
            <> <a href={comment.url} target="_blank" rel="noopener noreferrer">{t.openComment}</a></>
          )}
        </p>
        <textarea
          aria-label={t.jira(comment.key)}
          value={body}
          readOnly={comment.posted || comment.dismissed}
          rows={10}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="rep-jira-actions">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              void navigator.clipboard?.writeText(body).then(() => setCopied(true), () => undefined);
            }}
          >
            {copied ? t.copied : t.copy}
          </button>
          {!comment.posted && comment.dismissed && (
            <button type="button" className="btn small" onClick={() => void setDismissed(false)}>{t.restore}</button>
          )}
          {!comment.posted && !comment.dismissed && (
            <button type="button" className="btn small" onClick={() => void setDismissed(true)}>
              {dismissArmed ? t.confirmDismiss : t.dismiss}
            </button>
          )}
          {!comment.posted && !comment.dismissed && (
            <button type="button" className="btn small primary" disabled={state === 'posting' || !body.trim()} onClick={() => void publish()}>
              {state === 'posting' ? t.publishing : state === 'armed' ? t.confirmPublish(comment.key) : t.publish(comment.key)}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Bugs found: a list that can be edited once the run finished (add the Jira key or link, fix a title, add or remove bugs). */
function BugsBlock({ automation, automations, bugs, count, t, onUpdate, onError }: {
  automation: Automation; automations: Automation[]; bugs: ReportBug[] | null; count: number; t: Text;
  onUpdate: (a: Automation) => void; onError: (e: unknown) => void;
}) {
  const lang = useLang();
  /** Other reports that list the same Jira key, e.g. "Smoke QA · 19 Nov". */
  const alsoIn = (key: string): string =>
    key
      ? automations
          .filter((o) => o.id !== automation.id && o.details?.bugs.some((b) => b.key.trim().toUpperCase() === key.trim().toUpperCase()))
          .map((o) => `${KIND_LABEL[lang][o.kind]} ${o.target} · ${shortLabel(new Date(o.startedAt), lang)}`)
          .join(', ')
      : '';
  const [draft, setDraft] = useState<ReportBugEdit[] | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (index: number, patch: Partial<ReportBug>): void =>
    setDraft((d) => d && d.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const missingTitle = draft?.some((b) => !b.title.trim()) ?? false;
  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      onUpdate(await api.updateReportBugs(automation.id, lang, draft));
      setDraft(null);
    } catch (error) {
      onError(error);
    }
    setSaving(false);
  };
  const field = (index: number, name: keyof ReportBug, label: string, extra: { placeholder?: string; list?: string; wide?: boolean } = {}) => (
    <label className={`f${extra.wide ? ' wide' : ''}`}>
      {label}
      <input
        value={draft?.[index]?.[name] ?? ''}
        placeholder={extra.placeholder}
        list={extra.list}
        onChange={(e) => set(index, { [name]: name === 'key' ? e.target.value.toUpperCase() : e.target.value })}
      />
    </label>
  );

  return (
    <>
      <h3 className="rep-h rep-h-row">
        {t.bugs} <span className="hint">({draft ? draft.length : count})</span>
        {!draft && (
          <button type="button" className="btn small" onClick={() => setDraft((bugs ?? []).map((b, i) => ({ ...b, from: i })))}>
            <Icon name="edit" size={14} /> {t.editBugs}
          </button>
        )}
      </h3>
      {draft ? (
        <div className="rep-bugs-edit">
          {draft.map((_, i) => (
            <div key={i} className="rep-bug-edit">
              <div className="rep-bug-grid">
                {field(i, 'key', t.bugKey, { placeholder: 'AVM-123' })}
                {field(i, 'severity', t.severity, { list: 'rep-severities' })}
                {field(i, 'module', t.module)}
                {field(i, 'title', t.bugTitle, { wide: true })}
                {field(i, 'link', t.link, { placeholder: t.linkPh, wide: true })}
              </div>
              <button type="button" className="icon-btn danger" aria-label={t.removeBug(i + 1)} title={t.removeBug(i + 1)}
                onClick={() => setDraft((d) => d && d.filter((_, j) => j !== i))}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
          <datalist id="rep-severities">{['Critical', 'High', 'Medium', 'Low'].map((s) => <option key={s} value={s} />)}</datalist>
          <div className="rep-jira-actions">
            <button type="button" className="btn small"
              onClick={() => setDraft((d) => [...(d ?? []), { from: null, key: '', title: '', severity: '', module: '', link: '' }])}>
              <Icon name="plus" size={14} /> {t.addBug}
            </button>
            <div className="spacer" />
            {missingTitle && <span className="hint">{t.needsTitle}</span>}
            <button type="button" className="btn small" disabled={saving} onClick={() => setDraft(null)}>{t.cancel}</button>
            <button type="button" className="btn small primary" disabled={saving || missingTitle} onClick={() => void save()}>
              {saving ? t.saving : t.save}
            </button>
          </div>
        </div>
      ) : bugs && bugs.length > 0 ? (
        <ul className="rep-bugs">
          {bugs.map((b, i) => (
            <li key={i}>
              {b.severity && <span className="rep-sev">{b.severity}</span>}
              <div>
                <span>
                  {b.key && <b>{b.key} · </b>}
                  {b.title}
                </span>
                {b.module && <span className="hint">{b.module}</span>}
                {alsoIn(b.key) && <span className="hint rep-also">{t.alsoIn(alsoIn(b.key))}</span>}
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
        <p className="rep-empty">{count ? t.bugsNoDetail(count) : t.none}</p>
      )}
    </>
  );
}

/** Requests the report's translation if Claude wrote it in another language. */
function useTranslation(a: Automation, onUpdate: (a: Automation) => void): { failed: boolean; retry: () => void } {
  const lang = useLang();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = reportIn(a, lang).pending;
  const update = useRef(onUpdate);
  update.current = onUpdate;
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    setFailed(false);
    api.translateAutomation(a.id, lang).then(
      (next) => alive && update.current(next),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [a.id, lang, pending, attempt]);
  return { failed: pending && failed, retry: () => setAttempt((n) => n + 1) };
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

/** QA report of a Claude automation: verdict, timings, modules with their steps, and bugs found. */
export function ReportDialog({ automation: a, run, automations, onClose, onStop, onUpdate, onError }: ReportDialogProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const activity = useActivity(a);
  const { summary, details, pending } = reportIn(a, lang);
  const translation = useTranslation(a, onUpdate);
  const [stopState, setStopState] = useState<'idle' | 'armed' | 'stopping'>('idle');
  const dialog = useModalDialog();
  const running = a.finishedAt === null;
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
            {a.dryRun && <p className="hint rep-dry">{t.dryRun}</p>}
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
              <span className="status-pill tone-prog pulsing"><i />{t.running} · {t.elapsed(elapsedMin(a))}</span>
              <span className="hint">{t.stillRunning}</span>
              <div className="spacer" />
              <button
                className="btn small danger"
                disabled={stopState === 'stopping'}
                onClick={() => {
                  if (stopState === 'armed') {
                    setStopState('stopping');
                    void onStop(a).then((stopped) => {
                      if (!stopped) setStopState('idle');
                    });
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

            {pending && (
              <p className="rep-translating hint">
                {translation.failed ? (
                  <>
                    {t.translateFailed}{' '}
                    <button type="button" className="link-btn" onClick={translation.retry}>{t.retry}</button>
                  </>
                ) : (
                  <><span className="spinner" /> {t.translating}</>
                )}
              </p>
            )}

            {summary && <p className="rep-summary">{summary}</p>}

            <h3 className="rep-h">{t.modules} {details && details.modules.length > 0 && <span className="hint">({details.modules.length})</span>}</h3>
            {details && details.modules.length > 0 ? (
              <div className="rep-modules">
                {details.modules.map((m, i) => <ModuleBlock key={i} module={m} t={t} />)}
              </div>
            ) : (
              <p className="rep-empty">{t.noDetails}</p>
            )}

            <BugsBlock automation={a} automations={automations} bugs={details?.bugs ?? null} count={bugCount} t={t} onUpdate={onUpdate} onError={onError} />

            {details?.notes && (
              <>
                <h3 className="rep-h">{t.notes}</h3>
                <p className="rep-notes">{details.notes}</p>
              </>
            )}

            {details?.jiraComment && (
              <JiraCommentBlock key={details.jiraComment.posted ? 'posted' : details.jiraComment.dismissed ? 'dismissed' : 'draft'} automation={a} comment={details.jiraComment} t={t} onUpdate={onUpdate} onError={onError} />
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
