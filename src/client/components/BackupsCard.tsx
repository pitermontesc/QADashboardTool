import { useCallback, useEffect, useState } from 'react';
import type { BackupInfo, BackupList, BackupReason } from '../../shared/types';
import { api } from '../api';
import { copyText } from '../clipboard';
import { useLang, useText } from '../i18n';

const TEXT = {
  es: {
    auto: 'Copias automáticas',
    autoHint: 'Cada día, antes del primer cambio, la app guarda una copia de sus datos (se conservan 14 días), y otra antes de importar o restaurar.',
    none: 'Todavía no hay copias: la primera se guarda con el primer cambio del día.',
    reasons: { daily: 'Diaria', 'before-import': 'Antes de importar', 'before-restore': 'Antes de restaurar', manual: 'Manual' } as Record<BackupReason, string>,
    counts: (runs: number, reports: number) => `${runs} ${runs === 1 ? 'registro' : 'registros'} · ${reports} ${reports === 1 ? 'reporte' : 'reportes'}`,
    restore: 'Restaurar',
    restoreAsk: 'Reemplaza los registros, reportes y ajustes actuales por los de esta copia (la conexión a Jira no cambia). Antes se guarda una copia de lo actual.',
    restoreYes: 'Sí, restaurar',
    cancel: 'Cancelar',
    busy: 'Para restaurar, espera a que terminen (o detén) las ejecuciones en curso y vacía la cola.',
    backupNow: 'Respaldar ahora',
    showAll: (n: number) => `Ver todas (${n})`,
    showLess: 'Ver menos',
    created: 'Copia guardada',
    folder: 'Carpeta',
    log: 'Log de la app',
    logHint: 'Lo que la app lanzó, encoló o pausó y los errores que tuvo. Si algo falla, copia las últimas líneas y compártelas (no incluyen el token de Jira).',
    copyLog: 'Copiar las últimas líneas',
    logCopied: (n: number) => `Log copiado (${n} ${n === 1 ? 'línea' : 'líneas'})`,
    logEmpty: 'El log todavía está vacío',
    copyFailed: 'No se pudo copiar al portapapeles: abre el log desde Ayuda → Mostrar el log de la app',
    file: 'Archivo',
  },
  en: {
    auto: 'Automatic copies',
    autoHint: 'Every day, before the first change, the app keeps a copy of its data (for 14 days), and another one before an import or a restore.',
    none: 'No copies yet: the first one is kept with the first change of the day.',
    reasons: { daily: 'Daily', 'before-import': 'Before import', 'before-restore': 'Before restore', manual: 'Manual' } as Record<BackupReason, string>,
    counts: (runs: number, reports: number) => `${runs} ${runs === 1 ? 'run' : 'runs'} · ${reports} ${reports === 1 ? 'report' : 'reports'}`,
    restore: 'Restore',
    restoreAsk: 'Replaces the current runs, reports and settings with the ones in this copy (the Jira connection does not change). A copy of the current data is kept first.',
    restoreYes: 'Yes, restore',
    cancel: 'Cancel',
    busy: 'To restore, wait for the runs in progress to finish (or stop them) and empty the queue.',
    backupNow: 'Back up now',
    showAll: (n: number) => `Show all (${n})`,
    showLess: 'Show less',
    created: 'Copy saved',
    folder: 'Folder',
    log: 'App log',
    logHint: 'What the app launched, queued or paused and the errors it hit. If something goes wrong, copy the last lines and share them (the Jira token is never in them).',
    copyLog: 'Copy the last lines',
    logCopied: (n: number) => `Log copied (${n} ${n === 1 ? 'line' : 'lines'})`,
    logEmpty: 'The log is still empty',
    copyFailed: 'Could not copy to the clipboard: open the log from Help → Show the app log',
    file: 'File',
  },
};

/** How many copies show before "Show all". */
const SHOWN = 5;

interface BackupsCardProps {
  /** A run in progress or queued: restoring is not possible until they are done. */
  busy: boolean;
  /** Restores a copy (the app takes the new state); rejects with the error to show. */
  onRestore: (name: string, when: string) => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The automatic copies of the data (restore one, or take one now) and the app's log. */
export function BackupsCard({ busy, onRestore, onNotice, onError }: BackupsCardProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const [list, setList] = useState<BackupList | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [all, setAll] = useState(false);
  const [logFile, setLogFile] = useState('');

  const load = useCallback(() => {
    api.listBackups().then(setList, (error: unknown) => onError(errorText(error)));
  }, [onError]);
  useEffect(load, [load]);

  const when = (b: BackupInfo): string =>
    new Date(b.at).toLocaleString(lang === 'en' ? 'en-US' : 'es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const backupNow = async (): Promise<void> => {
    setWorking(true);
    try {
      setList(await api.backupNow());
      onNotice(t.created);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const restore = async (b: BackupInfo): Promise<void> => {
    setWorking(true);
    try {
      await onRestore(b.name, when(b));
      setAsking(null);
      load();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const copyLog = async (): Promise<void> => {
    try {
      const { file, lines } = await api.getLog();
      setLogFile(file);
      if (lines.length === 0) {
        onNotice(t.logEmpty);
        return;
      }
      if (!(await copyText(lines.join('\n')))) {
        onError(t.copyFailed);
        return;
      }
      onNotice(t.logCopied(lines.length));
    } catch (error) {
      onError(errorText(error));
    }
  };

  const items = list?.items ?? [];
  const shown = all ? items : items.slice(0, SHOWN);

  return (
    <>
      <div className="backups">
        <div className="backups-head">
          <h4>{t.auto}</h4>
          <button className="btn small" disabled={working} onClick={() => void backupNow()}>{t.backupNow}</button>
        </div>
        <p className="hint">{t.autoHint}</p>
        {busy && items.length > 0 && <p className="hint text-warn">{t.busy}</p>}
        {list && items.length === 0 && <p className="hint">{t.none}</p>}
        <ul className="backup-list" aria-label={t.auto}>
          {shown.map((b) => (
            <li key={b.name} className="backup-row">
              <div className="backup-main">
                <span className="backup-what">
                  <strong>{when(b)}</strong> <span className="hint">· {t.reasons[b.reason]}</span>
                </span>
                <span className="hint">{t.counts(b.runs, b.reports)}</span>
                {asking !== b.name && (
                  <button className="btn small" disabled={busy || working} onClick={() => setAsking(b.name)} aria-label={`${t.restore} ${when(b)}`}>
                    {t.restore}
                  </button>
                )}
              </div>
              {asking === b.name && (
                <div className="backup-confirm" role="group" aria-label={`${t.restore} ${when(b)}`}>
                  <p className="hint">{t.restoreAsk}</p>
                  <div className="row" style={{ margin: 0 }}>
                    <button className="btn small danger" disabled={busy || working} onClick={() => void restore(b)}>{t.restoreYes}</button>
                    <button className="btn small" disabled={working} onClick={() => setAsking(null)}>{t.cancel}</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {items.length > SHOWN && (
          <button className="link-btn" onClick={() => setAll(!all)}>{all ? t.showLess : t.showAll(items.length)}</button>
        )}
        {list && <p className="hint path">{t.folder}: <code>{list.dir}</code></p>}
      </div>

      <div className="backups">
        <h4>{t.log}</h4>
        <p className="hint">{t.logHint}</p>
        <div className="row" style={{ margin: 0 }}>
          <button className="btn small" onClick={() => void copyLog()}>{t.copyLog}</button>
        </div>
        {logFile && <p className="hint path">{t.file}: <code>{logFile}</code></p>}
      </div>
    </>
  );
}
