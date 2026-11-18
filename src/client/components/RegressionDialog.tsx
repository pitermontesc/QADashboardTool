import { useEffect, useRef, useState, type FormEvent } from 'react';
import { REGRESSION_SKILL, isTestRunRef } from '../../shared/orchestrator';
import { Icon } from './icons';

interface RegressionDialogProps {
  onLaunch: (run: string) => Promise<boolean>;
  onClose: () => void;
}

/** Pide el test run de testomat.io y abre el runner de regresión en Terminal. */
export function RegressionDialog({ onLaunch, onClose }: RegressionDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState('');
  const [launching, setLaunching] = useState(false);
  const value = run.trim();
  const valid = isTestRunRef(value);

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
            <h2 id="regression-title">Ejecutar regresión</h2>
            <p className="hint">Abre Terminal con Claude Code y el skill de regresión contra staging.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <label className="f">
          Test run de testomat.io <span className="hint">(opcional)</span>
          <input
            autoFocus
            placeholder="https://app.testomat.io/projects/…/runs/… o #b333fb92"
            value={run}
            onChange={(e) => setRun(e.target.value)}
            aria-invalid={!valid}
          />
        </label>
        {valid ? (
          <p className="hint">Si lo dejas vacío, el skill te pedirá el test run en Terminal.</p>
        ) : (
          <p className="hint text-bad">Pega el link de testomat.io o el ID del run (p. ej. #b333fb92).</p>
        )}

        <p className="hint cmd-preview"><code>claude --chrome '{value ? `${REGRESSION_SKILL} ${value}` : REGRESSION_SKILL}'</code></p>

        <div className="actions">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={!valid || launching}>
            <Icon name="play" /> {launching ? 'Abriendo Terminal…' : 'Abrir en Terminal'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
