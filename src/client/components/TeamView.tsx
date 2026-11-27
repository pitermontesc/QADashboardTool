import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatDmy, parseYmd, relativeTime, toYmd } from '../../shared/dates';
import { bugKeysByRun, countedRuns, filterByPeriod, sortRuns, summarize, type Period, type Summary } from '../../shared/stats';
import type { Automation, Lang, TeamMember, TeamView as TeamData, TestRun } from '../../shared/types';
import { api } from '../api';
import { useLang, useText } from '../i18n';
import { useNow } from '../useNow';
import { KIND_LABEL, VERDICT_TONE } from './Automations';
import { Icon } from './icons';
import { ResultPill } from './ui';

const PERIODS: readonly Period[] = [7, 30, 90, 0];
/** A teammate whose app has not written for this long is shown as possibly out of date. */
const STALE_MS = 3 * 24 * 60 * 60_000;
/** How often the open team view reads the folder again. */
const REFRESH_MS = 60_000;

const TEXT = {
  es: {
    title: 'Equipo',
    intro: 'Junta tus registros y reportes con los de las otras QAs en una sola vista, sin servidor: cada app deja su propio archivo en una carpeta que el equipo sincroniza (Google Drive, Dropbox, iCloud u OneDrive) y lee los de las demás.',
    shared: 'Se comparte: tus registros (título, ticket, tipo, ambiente, casos, bugs, minutos, resultado y notas) y los reportes QA de tus ejecuciones con Claude.',
    notShared: 'Nunca se comparte: tu token ni tu email de Jira, tus ajustes ni nada de tu Mac.',
    sameFolder: 'Todas tienen que elegir la misma carpeta compartida.',
    folder: 'Carpeta del equipo', folderPh: '~/Library/CloudStorage/GoogleDrive-…/Unidades compartidas/QA/QA Team',
    found: 'Carpetas sincronizadas en esta Mac (elige una y agrega el nombre de la carpeta del equipo):',
    name: 'Tu nombre en el equipo', namePh: 'Nombre Apellido',
    join: 'Unirme al equipo', save: 'Guardar', joining: 'Guardando…', cancel: 'Cancelar',
    loading: 'Leyendo la carpeta del equipo…',
    folderLine: 'Carpeta', you: 'Tú', yourFile: (file: string, when: string) => `Tu archivo ${file} se actualizó ${when}.`,
    refresh: 'Actualizar', change: 'Cambiar carpeta o nombre', leave: 'Dejar el equipo',
    leaveAsk: 'Tu archivo sale de la carpeta del equipo y las demás dejan de ver tus datos. Tus datos en esta Mac no cambian.',
    leaveYes: 'Sí, dejar el equipo',
    problems: 'Archivos que no se pudieron leer',
    alone: 'Todavía no hay nadie más en esta carpeta. Cuando las demás elijan la misma carpeta, aparecen aquí.',
    summary: 'Resumen del equipo', periodLabel: 'Período',
    period: (p: Period) => (p === 0 ? 'Todo' : `${p} días`),
    executions: 'Ejecuciones', cases: 'Casos ejecutados', passRate: 'Pass rate', bugs: 'Bugs encontrados', time: 'Tiempo',
    people: (n: number) => `${n} ${n === 1 ? 'persona' : 'personas'}`,
    passBasis: (num: number, den: number, cases: boolean) => `${num} de ${den} ${cases ? 'casos' : 'ejecuciones'}`,
    bugsOnce: 'un bug con la misma clave cuenta una vez',
    perPerson: 'Por persona',
    cols: { who: 'QA', runs: 'Ejecuciones', cases: 'Casos', pass: 'Pass rate', bugs: 'Bugs', time: 'Tiempo', last: 'Última actividad', file: 'Archivo' },
    runningNow: (what: string) => `Corriendo ${what}`,
    stale: 'Sin actualizar hace días: ¿su app está abierta y sincronizando?',
    tickets: 'Tickets validados', ticketsHint: 'Ejecuciones del orquestador del período, la más reciente primero. Pulsa una para ver su reporte.',
    noTickets: 'Nadie validó tickets con el orquestador en este período.',
    tcols: { ticket: 'Ticket', what: 'Qué', who: 'QA', verdict: 'Veredicto', when: 'Cuándo' },
    recent: 'Últimos registros del equipo',
    rcols: { date: 'Fecha', who: 'QA', title: 'Título', type: 'Tipo', ticket: 'Ticket', result: 'Resultado' },
    noRuns: 'Sin registros en este período.',
    hours: (m: number) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`),
  },
  en: {
    title: 'Team',
    intro: 'Brings your runs and reports together with the other QAs\' in one view, with no server: each app leaves its own file in a folder the team syncs (Google Drive, Dropbox, iCloud or OneDrive) and reads everyone else\'s.',
    shared: 'Shared: your runs (title, ticket, type, environment, cases, bugs, minutes, result and notes) and the QA reports of your Claude runs.',
    notShared: 'Never shared: your Jira token or email, your settings or anything about your Mac.',
    sameFolder: 'Everyone has to choose the same shared folder.',
    folder: 'Team folder', folderPh: '~/Library/CloudStorage/GoogleDrive-…/Shared drives/QA/QA Team',
    found: 'Synced folders on this Mac (pick one and add the name of the team folder):',
    name: 'Your name in the team', namePh: 'First Last',
    join: 'Join the team', save: 'Save', joining: 'Saving…', cancel: 'Cancel',
    loading: 'Reading the team folder…',
    folderLine: 'Folder', you: 'You', yourFile: (file: string, when: string) => `Your file ${file} was updated ${when}.`,
    refresh: 'Refresh', change: 'Change folder or name', leave: 'Leave the team',
    leaveAsk: 'Your file leaves the team folder and the others stop seeing your data. Your data on this Mac does not change.',
    leaveYes: 'Yes, leave the team',
    problems: 'Files that could not be read',
    alone: 'Nobody else is in this folder yet. When the others choose the same folder, they show up here.',
    summary: 'Team summary', periodLabel: 'Period',
    period: (p: Period) => (p === 0 ? 'All' : `${p} days`),
    executions: 'Runs', cases: 'Cases executed', passRate: 'Pass rate', bugs: 'Bugs found', time: 'Time',
    people: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
    passBasis: (num: number, den: number, cases: boolean) => `${num} of ${den} ${cases ? 'cases' : 'runs'}`,
    bugsOnce: 'a bug with the same key counts once',
    perPerson: 'Per person',
    cols: { who: 'QA', runs: 'Runs', cases: 'Cases', pass: 'Pass rate', bugs: 'Bugs', time: 'Time', last: 'Last activity', file: 'File' },
    runningNow: (what: string) => `Running ${what}`,
    stale: 'Not updated for days: is their app open and syncing?',
    tickets: 'Validated tickets', ticketsHint: 'Orchestrator runs in the period, newest first. Click one to see its report.',
    noTickets: 'Nobody validated tickets with the orchestrator in this period.',
    tcols: { ticket: 'Ticket', what: 'What', who: 'QA', verdict: 'Verdict', when: 'When' },
    recent: 'Latest team runs',
    rcols: { date: 'Date', who: 'QA', title: 'Title', type: 'Type', ticket: 'Ticket', result: 'Result' },
    noRuns: 'No runs in this period.',
    hours: (m: number) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`),
  },
};
type Text = (typeof TEXT)[Lang];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const passTone = (rate: number | null): string => (rate === null ? '' : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'bad');
const pct = (rate: number | null): string => (rate === null ? '—' : `${rate}%`);

interface TeamViewProps {
  onOpenReport: (automation: Automation, member: TeamMember) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/** Join form: the shared folder and the name the team sees. */
function JoinForm({ initial, t, onSaved, onCancel, onError }: {
  initial: { folder: string; name: string }; t: Text; onSaved: (view: TeamData) => void; onCancel?: () => void; onError: (m: string) => void;
}) {
  const [folder, setFolder] = useState(initial.folder);
  const [name, setName] = useState(initial.name);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.teamFolders().then((r) => setSuggestions(r.suggestions), () => undefined);
    // Your name in the team: the one in your QA profile, if you have one.
    if (!initial.name) api.getProfile().then((p) => p.tester && setName((n) => n || p.tester!.name), () => undefined);
  }, [initial.name]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      onSaved(await api.joinTeam(folder, name));
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="team-join" onSubmit={(e) => void submit(e)}>
      <label className="f">
        {t.folder}
        <input value={folder} placeholder={t.folderPh} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
      </label>
      {suggestions.length > 0 && (
        <div className="team-suggest">
          <span className="hint">{t.found}</span>
          {suggestions.map((s) => (
            <button key={s} type="button" className="link-btn" onClick={() => setFolder(`${s}/QA Team`)}>{s}</button>
          ))}
        </div>
      )}
      <label className="f">
        {t.name}
        <input value={name} placeholder={t.namePh} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row" style={{ margin: 0 }}>
        <button className="btn primary" type="submit" disabled={saving || !folder.trim() || !name.trim()}>
          {saving ? t.joining : onCancel ? t.save : t.join}
        </button>
        {onCancel && <button className="btn" type="button" onClick={onCancel}>{t.cancel}</button>}
      </div>
    </form>
  );
}

interface MemberStats {
  member: TeamMember;
  runs: TestRun[];
  summary: Summary;
  last: string | null;
  running: Automation | undefined;
}

/** The team view: everyone's numbers, who validated which ticket, and the latest runs. */
export function TeamView({ onOpenReport, onNotice, onError }: TeamViewProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const now = useNow();
  const [view, setView] = useState<TeamData | null>(null);
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [period, setPeriod] = useState<Period>(30);

  const load = useCallback(() => {
    api.getTeam().then(setView, (error: unknown) => onError(errorText(error)));
  }, [onError]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const todayYmd = toYmd(new Date(now));
  const stats = useMemo(() => {
    if (!view || !view.folder) return null;
    const today = parseYmd(todayYmd);
    const members: MemberStats[] = view.members.map((member) => {
      const runs = filterByPeriod(countedRuns(member.runs), period, today);
      return {
        member,
        runs,
        summary: summarize(runs, bugKeysByRun(member.automations)),
        last: sortRuns(member.runs)[0]?.date ?? null,
        running: member.automations.find((a) => a.finishedAt === null),
      };
    });
    // Team totals: a Jira bug found by two people counts once.
    const allKeys = new Map(view.members.flatMap((m) => [...bugKeysByRun(m.automations)]));
    const total = summarize(members.flatMap((m) => m.runs), allKeys);
    const from = period === 0 ? 0 : today.getTime() - (period - 1) * 86_400_000;
    const tickets = view.members
      .flatMap((m) => m.automations.filter((a) => a.kind === 'orchestrator' && a.finishedAt !== null && a.startedAt >= from && !a.dryRun).map((a) => ({ a, m })))
      .sort((x, y) => y.a.finishedAt! - x.a.finishedAt!)
      .slice(0, 50);
    const recent = sortRuns(members.flatMap((m) => m.runs.map((r) => ({ ...r, id: `${m.member.id}:${r.id}` }))))
      .slice(0, 30)
      .map((r) => {
        const owner = members.find((m) => r.id.startsWith(`${m.member.id}:`))!.member;
        return { run: r, owner, type: owner.types.find((ty) => ty.id === r.typeId) };
      });
    return { members, total, tickets, recent };
  }, [view, period, todayYmd]);

  const leave = async (): Promise<void> => {
    try {
      setView(await api.leaveTeam());
      setLeaving(false);
    } catch (error) {
      onError(errorText(error));
    }
  };

  if (!view) return <section><p className="hint"><span className="spinner" /> {t.loading}</p></section>;

  if (!view.folder || editing) {
    return (
      <section>
        <div className="card team-intro">
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
          <ul className="team-facts">
            <li><Icon name="check" size={14} /> {t.shared}</li>
            <li><Icon name="close" size={14} /> {t.notShared}</li>
            <li><Icon name="alert" size={14} /> {t.sameFolder}</li>
          </ul>
          <JoinForm
            initial={{ folder: view.folder, name: view.name }}
            t={t}
            onSaved={(next) => {
              setView(next);
              setEditing(false);
              onNotice(t.title);
            }}
            onCancel={view.folder ? () => setEditing(false) : undefined}
            onError={onError}
          />
        </div>
      </section>
    );
  }

  const me = view.members.find((m) => m.me);
  const kpis: [string, string, string, string][] = stats
    ? [
        [t.executions, String(stats.total.executions), t.people(view.members.length), ''],
        [t.cases, String(stats.total.cases), '', ''],
        [t.passRate, pct(stats.total.passRate), stats.total.passRateBasis === 'none' ? '' : t.passBasis(stats.total.passNumerator, stats.total.passDenominator, stats.total.passRateBasis === 'cases'), passTone(stats.total.passRate)],
        [t.bugs, String(stats.total.bugs), t.bugsOnce, stats.total.bugs ? 'bad' : ''],
        [t.time, t.hours(stats.total.minutes), '', ''],
      ]
    : [];

  return (
    <section className="team">
      <div className="card team-head">
        <div className="card-head" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>{t.title}</h3>
          <div className="spacer" />
          <button className="btn small" onClick={load}><Icon name="refresh" size={14} /> {t.refresh}</button>
          <button className="btn small" onClick={() => setEditing(true)}>{t.change}</button>
          {!leaving && <button className="btn small danger" onClick={() => setLeaving(true)}>{t.leave}</button>}
        </div>
        <p className="hint path">{t.folderLine}: <code>{view.folder}</code></p>
        {me && view.writtenAt !== null && <p className="hint">{t.yourFile(view.ownFile, relativeTime(view.writtenAt, now, lang))}</p>}
        {view.error && <p className="callout bad">{view.error}</p>}
        {leaving && (
          <div className="backup-confirm" role="group" aria-label={t.leave}>
            <p className="hint">{t.leaveAsk}</p>
            <div className="row" style={{ margin: 0 }}>
              <button className="btn small danger" onClick={() => void leave()}>{t.leaveYes}</button>
              <button className="btn small" onClick={() => setLeaving(false)}>{t.cancel}</button>
            </div>
          </div>
        )}
        {view.problems.length > 0 && (
          <details className="team-problems">
            <summary className="text-warn">{t.problems} ({view.problems.length})</summary>
            <ul>{view.problems.map((p) => <li key={p.file}><code>{p.file}</code>: {p.error}</li>)}</ul>
          </details>
        )}
        {view.members.length === 1 && !view.error && <p className="hint">{t.alone}</p>}
      </div>

      <div className="row section-head">
        <h2>{t.summary}</h2>
        <div className="spacer" />
        <div className="seg" role="group" aria-label={t.periodLabel}>
          {PERIODS.map((p) => (
            <button key={p} className={p === period ? 'on' : ''} aria-pressed={p === period} onClick={() => setPeriod(p)}>
              {t.period(p)}
            </button>
          ))}
        </div>
      </div>
      <div className="kpis">
        {kpis.map(([label, value, sub, tone]) => (
          <div key={label} className="card kpi">
            <div className="lbl">{label}</div>
            <div className={`val${tone ? ` text-${tone}` : ''}`}>{value}</div>
            <div className="sub">{sub || ' '}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>{t.perPerson}</h3>
        <div className="tablewrap">
          <table className="team-table">
            <thead>
              <tr>{Object.values(t.cols).map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {stats?.members.map(({ member, summary, last, running }) => {
                const stale = !member.me && now - member.updatedAt > STALE_MS;
                return (
                  <tr key={member.id}>
                    <td>
                      <b>{member.name}</b> {member.me && <span className="tag">{t.you}</span>}
                      {running && (
                        <button className="status-pill tone-prog pulsing pill-btn team-running" onClick={() => onOpenReport(running, member)}>
                          <i />{t.runningNow(`${KIND_LABEL[lang][running.kind]} ${running.target}`.trim())}
                        </button>
                      )}
                    </td>
                    <td className="num">{summary.executions}</td>
                    <td className="num">{summary.cases}</td>
                    <td className={`num text-${passTone(summary.passRate)}`}>{pct(summary.passRate)}</td>
                    <td className="num">{summary.bugs}</td>
                    <td className="num">{t.hours(summary.minutes)}</td>
                    <td>{last ? formatDmy(last, lang) : '—'}</td>
                    <td className={stale ? 'text-warn' : 'hint'} title={stale ? t.stale : member.file}>
                      {stale && <Icon name="alert" size={12} />} {relativeTime(member.updatedAt, now, lang)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>{t.tickets}</h3>
        <p className="hint">{t.ticketsHint}</p>
        {stats && stats.tickets.length === 0 ? (
          <p className="empty-msg">{t.noTickets}</p>
        ) : (
          <div className="tablewrap">
            <table className="team-table">
              <thead><tr>{Object.values(t.tcols).map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {stats?.tickets.map(({ a, m }) => (
                  <tr key={`${m.id}:${a.id}`} className="clickable" onClick={() => onOpenReport(a, m)}>
                    <td><button className="link-btn" onClick={(e) => { e.stopPropagation(); onOpenReport(a, m); }}>{a.target}</button></td>
                    <td className="team-what">{a.title.replace(/^.*?·\s*/, '') || a.target}</td>
                    <td>{m.name}</td>
                    <td>{a.verdict && <span className={`status-pill tone-${VERDICT_TONE[a.verdict]}`}><i />{a.verdict}</span>}</td>
                    <td className="hint">{relativeTime(a.finishedAt!, now, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t.recent}</h3>
        {stats && stats.recent.length === 0 ? (
          <p className="empty-msg">{t.noRuns}</p>
        ) : (
          <div className="tablewrap">
            <table className="team-table">
              <thead><tr>{Object.values(t.rcols).map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {stats?.recent.map(({ run, owner, type }) => (
                  <tr key={run.id}>
                    <td>{formatDmy(run.date, lang)}</td>
                    <td>{owner.name}</td>
                    <td className="team-what">{run.title}</td>
                    <td>{type?.name ?? '—'}</td>
                    <td>{run.ticket || '—'}</td>
                    <td><ResultPill result={run.result} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
