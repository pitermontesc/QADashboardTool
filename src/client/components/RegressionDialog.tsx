import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isTestRunRef } from '../../shared/orchestrator';
import type { QaConfig } from '../../shared/types';
import { Icon } from './icons';
import { useText } from '../i18n';

const TEXT = {
  es: {
    title: 'Ejecutar regresión', sub: 'Corre Claude Code en segundo plano con el skill de regresión contra staging.', close: 'Cerrar',
    run: 'Test run', optional: '(opcional)', placeholder: (host: string) => `https://app.${host}/projects/…/runs/… o #b333fb92`,
    emptyHint: 'Si lo dejas vacío, el skill elige el test run que corresponda o reporta BLOCKED si no puede.',
    invalid: (hosts: string) => `Pega el link del test run (${hosts}) o su ID (p. ej. #b333fb92).`,
    cancel: 'Cancelar', opening: 'Iniciando…', open: 'Ejecutar',
  },
  en: {
    title: 'Run regression', sub: 'Runs Claude Code in the background with the regression skill against staging.', close: 'Close',
    run: 'Test run', optional: '(optional)', placeholder: (host: string) => `https://app.${host}/projects/…/runs/… or #b333fb92`,
    emptyHint: 'If you leave it empty, the skill picks the right test run or reports BLOCKED if it cannot.',
    invalid: (hosts: string) => `Paste the test run link (${hosts}) or its ID (e.g. #b333fb92).`,
    cancel: 'Cancel', opening: 'Starting…', open: 'Run',
  },
};

interface RegressionDialogProps {
  qa: QaConfig;
  onLaunch: (run: string) => Promise<boolean>;
  onClose: () => void;
}

/** Pide el test run (link de los dominios configurados o ID) y lanza el runner de regresión. */
export function RegressionDialog({ qa, onLaunch, onClose }: RegressionDialogProps) {
  const t = useText(TEXT);
  const dialog = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState('');
  const [launching, setLaunching] = useState(false);
  const value = run.trim();
  const valid = isTestRunRef(value, qa.testRunHosts);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || launching) return;
    setLaunching(true);
    if (await onLaunch(value)) onClose();
    else setLaunching(false);
  };

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="regression-title" className="narrow">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div>
            <h2 id="regression-title">{t.title}</h2>
            <p className="hint">{t.sub}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <label className="f">
          {t.run} <span className="hint">{t.optional}</span>
          <input
            autoFocus
            placeholder={t.placeholder(qa.testRunHosts[0] ?? 'testomat.io')}
            value={run}
            onChange={(e) => setRun(e.target.value)}
            aria-invalid={!valid}
          />
        </label>
        {valid ? (
          <p className="hint">{t.emptyHint}</p>
        ) : (
          <p className="hint text-bad">{t.invalid(qa.testRunHosts.join(', '))}</p>
        )}

        <p className="hint cmd-preview"><code>{value ? `${qa.skills.regression} ${value}` : qa.skills.regression}</code></p>

        <div className="actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="btn primary" disabled={!valid || launching}>
            <Icon name="play" /> {launching ? t.opening : t.open}
          </button>
        </div>
      </form>
    </dialog>
  );
}
