import { useEffect, useRef, useState, type FormEvent } from 'react';
import { REGRESSION_DRY_RUN, isTestRunRef } from '../../shared/orchestrator';
import type { QaConfig } from '../../shared/types';
import { Icon } from './icons';
import { useText } from '../i18n';

const TEXT = {
  es: {
    title: 'Ejecutar regresión', sub: 'Corre Claude Code en segundo plano con el skill de regresión contra staging.', close: 'Cerrar',
    run: 'Test run', optional: '(opcional)', placeholder: (host: string) => `https://app.${host}/projects/…/runs/… o #b333fb92`,
    emptyHint: 'Si lo dejas vacío, el skill elige el test run que corresponda o reporta BLOCKED si no puede.',
    invalid: (hosts: string) => `Pega el link del test run (${hosts}) o su ID (p. ej. #b333fb92).`,
    cancel: 'Cancelar', opening: 'Iniciando…', open: 'Ejecutar', openDry: 'Ejecutar en modo prueba',
    dryRun: 'Modo prueba: solo lectura en Jira y testomat.io',
    dryRunHint: 'Valida los casos en el navegador como siempre, pero no crea el epic, las tareas, los bugs ni el comentario en Jira, y no marca resultados en testomat.io. El reporte queda en el dashboard y dice qué habría creado.',
  },
  en: {
    title: 'Run regression', sub: 'Runs Claude Code in the background with the regression skill against staging.', close: 'Close',
    run: 'Test run', optional: '(optional)', placeholder: (host: string) => `https://app.${host}/projects/…/runs/… or #b333fb92`,
    emptyHint: 'If you leave it empty, the skill picks the right test run or reports BLOCKED if it cannot.',
    invalid: (hosts: string) => `Paste the test run link (${hosts}) or its ID (e.g. #b333fb92).`,
    cancel: 'Cancel', opening: 'Starting…', open: 'Run', openDry: 'Run in test mode',
    dryRun: 'Test mode: read-only in Jira and testomat.io',
    dryRunHint: 'Validates the test cases in the browser as usual, but does not create the epic, tasks, bugs or comment in Jira, and does not mark results in testomat.io. The report stays in the dashboard and says what it would have created.',
  },
};

interface RegressionDialogProps {
  qa: QaConfig;
  onLaunch: (run: string, dryRun: boolean) => Promise<boolean>;
  onClose: () => void;
}

/** Asks for the test run (a link on the configured domains, or an ID) and launches the regression runner. */
export function RegressionDialog({ qa, onLaunch, onClose }: RegressionDialogProps) {
  const t = useText(TEXT);
  const dialog = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState('');
  const [dryRun, setDryRun] = useState(false);
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
    if (await onLaunch(value, dryRun)) onClose();
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

        <label className="check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>
            {t.dryRun}
            <span className="hint">{t.dryRunHint}</span>
          </span>
        </label>

        <p className="hint cmd-preview">
          <code>{`${value ? `${qa.skills.regression} ${value}` : qa.skills.regression}${dryRun ? REGRESSION_DRY_RUN : ''}`}</code>
        </p>

        <div className="actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="btn primary" disabled={!valid || launching}>
            <Icon name="play" /> {launching ? t.opening : dryRun ? t.openDry : t.open}
          </button>
        </div>
      </form>
    </dialog>
  );
}
