import { useState } from 'react';
import { formatDmy, toYmd } from '../../shared/dates';
import { candidateReason, formatMinutes, laneOf, laneSchedule, orderedSites, ticketReason, ticketsToValidate } from '../../shared/queue';
import type { AppState, QaSite, QueueItem } from '../../shared/types';
import { useLang, useText } from '../i18n';
import { KIND_LABEL } from './Automations';
import { Icon } from './icons';
import { useModalDialog } from './ui';

const TEXT = {
  es: {
    title: 'Cola de ejecuciones',
    sub: 'Una ejecución a la vez por sitio: la siguiente empieza sola cuando el sitio se libera.',
    runningNow: (what: string) => `En curso: ${what}`,
    free: 'Libre',
    paused: 'En pausa',
    pausedWhy: (why: string) => `Claude no pudo empezar: ${why}`,
    resume: 'Reanudar',
    up: (what: string) => `Subir ${what}`,
    down: (what: string) => `Bajar ${what}`,
    remove: (what: string) => `Quitar ${what} de la cola`,
    // Validate all
    dialogTitle: 'Validar todos los tickets',
    dialogSub: 'Se encolan en su sitio según su estado de Jira y corren uno a la vez por sitio, del más urgente al más antiguo. Nada empieza hasta que confirmes.',
    laneHint: (busy: boolean): string => (busy ? 'El sitio está ocupado: el primero empieza cuando se libere.' : 'El primero empieza ahora.'),
    laneTotal: (total: string, end: string) => `${total} en total · libre ~${end}`,
    startsAt: (time: string) => `empieza ~${time}`,
    freeAt: (time: string) => `libre ~${time}`,
    lastRun: (date: string, verdict: string) => `Validado el ${date}: ${verdict}`,
    none: 'No hay tickets listos para validar: los que están en un estado del orquestador ya corren o están en la cola.',
    cancel: 'Cancelar',
    confirm: (n: number) => (n === 1 ? 'Encolar 1 ticket' : `Encolar ${n} tickets`),
    queueing: 'Encolando…',
    close: 'Cerrar',
  },
  en: {
    title: 'Run queue',
    sub: 'One run at a time per site: the next one starts on its own when the site is free.',
    runningNow: (what: string) => `Running: ${what}`,
    free: 'Free',
    paused: 'Paused',
    pausedWhy: (why: string) => `Claude could not start: ${why}`,
    resume: 'Resume',
    up: (what: string) => `Move ${what} up`,
    down: (what: string) => `Move ${what} down`,
    remove: (what: string) => `Remove ${what} from the queue`,
    dialogTitle: 'Validate all tickets',
    dialogSub: 'They are queued on their site according to their Jira status and run one at a time per site, most urgent first, then the oldest. Nothing starts until you confirm.',
    laneHint: (busy: boolean): string => (busy ? 'The site is busy: the first one starts when it is free.' : 'The first one starts now.'),
    laneTotal: (total: string, end: string) => `${total} in all · free ~${end}`,
    startsAt: (time: string) => `starts ~${time}`,
    freeAt: (time: string) => `free ~${time}`,
    lastRun: (date: string, verdict: string) => `Validated on ${date}: ${verdict}`,
    none: 'No tickets are ready to validate: the ones in an orchestrator status are already running or queued.',
    cancel: 'Cancel',
    confirm: (n: number) => (n === 1 ? 'Queue 1 ticket' : `Queue ${n} tickets`),
    queueing: 'Queueing…',
    close: 'Close',
  },
};

/** "15:40": estimates are rough, so no seconds. */
const clock = (at: number, lang: 'es' | 'en'): string =>
  new Date(at).toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-ES', { hour: '2-digit', minute: '2-digit' });

/** "AVM-7057", "Smoke QA" or "Regression #b333fb92", as the run is shown elsewhere. */
export function queueLabel(item: Pick<QueueItem, 'kind' | 'target'>, lang: 'es' | 'en'): string {
  return item.kind === 'orchestrator' ? item.target : `${KIND_LABEL[lang][item.kind]} ${item.target}`.trim();
}

interface QueuePanelProps {
  state: AppState;
  onMove: (item: QueueItem, direction: 'up' | 'down') => void;
  onRemove: (item: QueueItem) => void;
  onResume: (site: string) => void;
}

/** What is waiting on each site, in order, with what is running there now. */
export function QueuePanel({ state, onMove, onRemove, onResume }: QueuePanelProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const { items, paused } = state.queue;
  const { qa } = state.settings;
  const lanes = orderedSites(qa).filter((site) => items.some((q) => q.site === site.id) || paused[site.id] !== undefined);
  if (lanes.length === 0) return null;
  const summaryOf = (key: string): string => state.jira.tickets.find((tk) => tk.key === key)?.summary ?? '';

  return (
    <div className="card queue">
      <div className="card-head">
        <div>
          <h3 className="title">{t.title}</h3>
          <div className="card-sub"><span className="hint">{t.sub}</span></div>
        </div>
      </div>
      {lanes.map((site) => {
        const lane = items.filter((q) => q.site === site.id);
        const now = state.automations.find((a) => a.finishedAt === null && laneOf(a, qa) === site.id);
        const why = paused[site.id];
        const schedule = laneSchedule(state, site.id);
        return (
          <section key={site.id} className="queue-lane" aria-label={site.name}>
            <div className="queue-lane-head">
              <b>{site.name}</b>
              {why !== undefined ? (
                <span className="status-pill tone-warn"><i />{t.paused}</span>
              ) : now ? (
                <span className="status-pill tone-prog pulsing"><i />{t.runningNow(queueLabel(now, lang))}</span>
              ) : (
                <span className="status-pill tone-muted"><i />{t.free}</span>
              )}
              {why === undefined && lane.length > 0 && <span className="hint">{t.freeAt(clock(schedule.freeAt, lang))}</span>}
            </div>
            {why !== undefined && (
              <div className="queue-paused">
                <span className="text-bad">{t.pausedWhy(why)}</span>
                <button className="btn small" onClick={() => onResume(site.id)}>{t.resume}</button>
              </div>
            )}
            <ol className="queue-list">
              {lane.map((item, i) => {
                const label = queueLabel(item, lang);
                const ticket = item.kind === 'orchestrator' ? state.jira.tickets.find((tk) => tk.key === item.target) : undefined;
                return (
                  <li key={item.id} className="queue-row">
                    <span className="queue-n">{i + 1}</span>
                    <span className="queue-what">
                      <b>{label}</b>
                      {item.kind === 'orchestrator' && <span className="queue-sum">{summaryOf(item.target)}</span>}
                      <span className="hint">
                        {[ticket && ticketReason(ticket, lang), why === undefined && t.startsAt(clock(schedule.starts.get(item.id)!, lang))].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="queue-actions">
                      <button className="icon-btn" disabled={i === 0} onClick={() => onMove(item, 'up')} title={t.up(label)} aria-label={t.up(label)}>
                        <Icon name="up" size={14} />
                      </button>
                      <button className="icon-btn" disabled={i === lane.length - 1} onClick={() => onMove(item, 'down')} title={t.down(label)} aria-label={t.down(label)}>
                        <Icon name="down" size={14} />
                      </button>
                      <button className="icon-btn danger" onClick={() => onRemove(item)} title={t.remove(label)} aria-label={t.remove(label)}>
                        <Icon name="close" size={14} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

interface ValidateAllProps {
  state: AppState;
  /** Queues the chosen tickets; true on success (then the dialog closes). */
  onConfirm: (keys: string[]) => Promise<boolean>;
  onClose: () => void;
}

/** "Validate all": the ready tickets in the order they would run, to confirm before anything starts. */
export function ValidateAllDialog({ state, onConfirm, onClose }: ValidateAllProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const dialog = useModalDialog();
  // Read once: the list must not reorder under the user while the app refreshes.
  const [candidates] = useState(() => ticketsToValidate(state));
  const [chosen, setChosen] = useState(() => new Set(candidates.filter((c) => c.suggested).map((c) => c.ticket.key)));
  const [sending, setSending] = useState(false);
  const { qa } = state.settings;
  const lanes: QaSite[] = orderedSites(qa).filter((site) => candidates.some((c) => c.site.id === site.id));
  // Expected end of each site if every ticket shown were queued (rough: from earlier runs).
  const [now] = useState(() => Date.now());
  const total = (site: string): { minutes: number; end: number } => {
    const extra = candidates.filter((c) => c.site.id === site).map((c) => ({ id: c.ticket.key, kind: 'orchestrator' as const, target: c.ticket.key }));
    const { freeAt } = laneSchedule(state, site, now, extra);
    return { minutes: candidates.filter((c) => c.site.id === site).reduce((sum, c) => sum + c.estimate.minutes, 0), end: freeAt };
  };
  const busy = (site: string): boolean =>
    state.automations.some((a) => a.finishedAt === null && laneOf(a, qa) === site) || state.queue.items.some((q) => q.site === site);
  const toggle = (key: string): void =>
    setChosen((set) => {
      const next = new Set(set);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const confirm = async (): Promise<void> => {
    setSending(true);
    // In the order shown, which is the order they run in.
    if (await onConfirm(candidates.filter((c) => chosen.has(c.ticket.key)).map((c) => c.ticket.key))) onClose();
    else setSending(false);
  };

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="validate-all-title" className="validate-all">
      <div className="validate-body">
        <div className="dialog-head">
          <div>
            <h2 id="validate-all-title">{t.dialogTitle}</h2>
            <p className="hint wrap">{t.dialogSub}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {candidates.length === 0 && <p className="empty-msg">{t.none}</p>}
        {lanes.map((site) => (
          <section key={site.id} className="queue-lane" aria-label={site.name}>
            <div className="queue-lane-head">
              <b>{site.name}</b>
              <span className="hint">{t.laneHint(busy(site.id))}</span>
              <span className="hint">{(({ minutes, end }) => t.laneTotal(formatMinutes(minutes), clock(end, lang)))(total(site.id))}</span>
            </div>
            <ol className="queue-list">
              {candidates
                .filter((c) => c.site.id === site.id)
                .map((candidate) => {
                  const { ticket, last } = candidate;
                  return (
                  <li key={ticket.key} className="queue-row">
                    <label className="check queue-check">
                      <input type="checkbox" checked={chosen.has(ticket.key)} onChange={() => toggle(ticket.key)} aria-label={ticket.key} />
                      <span className="queue-what">
                        <b>{ticket.key}</b>
                        <span className="queue-sum">{ticket.summary}</span>
                        <span className="hint">
                          {[candidateReason(candidate, lang, now), last?.finishedAt && t.lastRun(formatDmy(toYmd(new Date(last.finishedAt)), lang), last.verdict ?? '')]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </label>
                  </li>
                  );
                })}
            </ol>
          </section>
        ))}
        <div className="actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{t.cancel}</button>
          <button type="button" className="btn primary" disabled={chosen.size === 0 || sending} onClick={() => void confirm()}>
            <Icon name="play" /> {sending ? t.queueing : t.confirm(chosen.size)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
