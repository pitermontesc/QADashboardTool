import { useState, type ReactNode } from 'react';
import type { Lang, UpdateState } from '../../shared/types';
import { useLang, useText } from '../i18n';
import { Icon } from './icons';

const ARCH: Record<string, string> = { arm64: 'Apple Silicon', x64: 'Intel' };

const TEXT = {
  es: {
    title: 'Versión de la app',
    youHave: (v: string, arch: string) => `Tienes la versión ${v}${arch ? ` para ${arch}` : ''}.`,
    available: 'Hay una versión nueva', upToDate: 'Al día', failed: 'Sin revisar',
    newVersion: (v: string, when: string) => `Nueva: ${v}${when ? `, publicada el ${when}` : ''}.`,
    download: (arch: string) => `Descargar para ${arch} (.dmg)`,
    release: 'Ver el release en GitHub',
    changes: 'Qué cambió',
    steps: [
      'Descarga el .dmg y ábrelo.',
      'Cierra QA Dashboard y arrastra la app nueva a Aplicaciones, reemplazando la anterior. Tus registros, reportes, ajustes y tu perfil QA se mantienen.',
      'Ábrela. La primera vez macOS la bloquea porque no está firmada: en Ajustes del Sistema → Privacidad y seguridad, pulsa Abrir igualmente.',
    ],
    busy: 'Antes de instalar, espera a que terminen las ejecuciones en curso y la cola: cerrar la app las detiene.',
    current: (v: string) => `Estás al día: la última versión publicada es la ${v}.`,
    none: 'Todavía no hay versiones publicadas.',
    never: 'Todavía no se buscaron actualizaciones.',
    error: (e: string) => `No se pudo revisar (${e}). La app sigue funcionando; vuelve a intentarlo más tarde.`,
    check: 'Buscar actualizaciones', checking: 'Buscando…',
    checkedAt: (time: string) => `Revisado a las ${time}`,
    auto: 'La app revisa sola al abrirse y cada 6 horas.',
  },
  en: {
    title: 'App version',
    youHave: (v: string, arch: string) => `You have version ${v}${arch ? ` for ${arch}` : ''}.`,
    available: 'A new version is out', upToDate: 'Up to date', failed: 'Not checked',
    newVersion: (v: string, when: string) => `New: ${v}${when ? `, published on ${when}` : ''}.`,
    download: (arch: string) => `Download for ${arch} (.dmg)`,
    release: 'See the release on GitHub',
    changes: 'What changed',
    steps: [
      'Download the .dmg and open it.',
      'Quit QA Dashboard and drag the new app to Applications, replacing the old one. Your runs, reports, settings and QA profile are kept.',
      'Open it. The first time, macOS blocks it because it is not signed: in System Settings → Privacy & Security, click Open Anyway.',
    ],
    busy: 'Before installing, wait for the runs in progress and the queue to finish: quitting the app stops them.',
    current: (v: string) => `You are up to date: the latest published version is ${v}.`,
    none: 'No version has been published yet.',
    never: 'Updates have not been checked yet.',
    error: (e: string) => `Could not check (${e}). The app keeps working; try again later.`,
    check: 'Check for updates', checking: 'Checking…',
    checkedAt: (time: string) => `Checked at ${time}`,
    auto: 'The app checks by itself when it opens and every 6 hours.',
  },
};

const locale = (lang: Lang) => (lang === 'en' ? 'en-US' : 'es-ES');

/** `**bold**` and `` `code` `` inside a line of the notes, as elements (never as HTML). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b>
    : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
    : part,
  );
}

/** Release notes written in Markdown (the CHANGELOG section): headings, bullets and paragraphs. */
export function ReleaseNotes({ notes }: { notes: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    items = [];
  };
  for (const line of notes.split('\n')) {
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) {
      items.push(bullet[1]!);
      continue;
    }
    flush();
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (heading) blocks.push(<h5 key={blocks.length}>{inline(heading[1]!)}</h5>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.trim())}</p>);
  }
  flush();
  return <div className="release-notes">{blocks}</div>;
}

interface UpdatesCardProps {
  update: UpdateState | null;
  /** Runs in progress or queued: quitting the app to install would stop them. */
  busy: boolean;
  onCheck: () => Promise<void>;
  onError: (message: string) => void;
}

/** Settings card: this version, and how to install a newer one if there is one. */
export function UpdatesCard({ update, busy, onCheck, onError }: UpdatesCardProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const [working, setWorking] = useState(false);
  if (!update) return null;

  const check = async (): Promise<void> => {
    setWorking(true);
    try {
      await onCheck();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };
  const { latest } = update;
  const arch = ARCH[update.arch] ?? '';
  const dmg = latest?.downloads.find((d) => d.arch === update.arch && d.kind === 'dmg');
  const when = latest?.publishedAt ? new Date(latest.publishedAt).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const status = update.available
    ? { text: t.available, tone: 'warn' }
    : update.error
      ? { text: t.failed, tone: 'muted' }
      : update.checkedAt !== null
        ? { text: t.upToDate, tone: 'ok' }
        : null;

  return (
    <div className="card updates" id="updates" style={{ marginBottom: 12 }}>
      <div className="card-head">
        <h3 style={{ margin: 0 }}>{t.title}</h3>
        {status && <span className={`pill ${status.tone}`}>{status.text}</span>}
      </div>
      <p className="hint">{t.youHave(update.current, arch)}</p>

      {update.available && latest && (
        <div className="update-new">
          <p><b>{t.newVersion(latest.version, when)}</b></p>
          <div className="row" style={{ margin: '8px 0' }}>
            {dmg && (
              <a className="btn primary" href={dmg.url} target="_blank" rel="noopener noreferrer">
                {t.download(arch)}
              </a>
            )}
            <a className="btn" href={latest.url} target="_blank" rel="noopener noreferrer">
              {t.release} <Icon name="external" size={12} />
            </a>
          </div>
          {busy && <p className="hint text-warn">{t.busy}</p>}
          <ol className="update-steps">
            {t.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          {latest.notes && (
            <details className="update-notes">
              <summary>{t.changes}</summary>
              <ReleaseNotes notes={latest.notes} />
            </details>
          )}
        </div>
      )}

      {!update.available && update.error && <p className="hint text-warn">{t.error(update.error)}</p>}
      {!update.available && !update.error && update.checkedAt !== null && <p className="hint">{latest ? t.current(latest.version) : t.none}</p>}
      {update.checkedAt === null && !update.error && <p className="hint">{t.never}</p>}

      <div className="row" style={{ margin: '8px 0 0', alignItems: 'center' }}>
        <button className="btn small" disabled={working} onClick={() => void check()}>
          <Icon name="refresh" size={14} /> {working ? t.checking : t.check}
        </button>
        <span className="hint">
          {update.checkedAt !== null ? `${t.checkedAt(new Date(update.checkedAt).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' }))}. ` : ''}
          {t.auto}
        </span>
      </div>
    </div>
  );
}
