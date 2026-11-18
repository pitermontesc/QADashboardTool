import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RESULT_META } from '../../shared/defaults';
import { RESULTS, type Result, type Settings, type TestRunInput } from '../../shared/types';
import { Icon } from './icons';
import { Kbd, MOD } from './ui';

interface RunFormProps {
  heading: string;
  initial: TestRunInput;
  settings: Settings;
  onSubmit: (input: TestRunInput) => Promise<boolean>;
  onClose: () => void;
}

const COUNT_FIELDS = [
  ['passed', 'Casos passed', 'ok'],
  ['failed', 'Casos failed', 'bad'],
  ['blocked', 'Casos blocked', 'warn'],
  ['bugs', 'Bugs', 'bad'],
  ['minutes', 'Minutos', ''],
] as const;
type CountField = (typeof COUNT_FIELDS)[number][0];

const toText = (n: number | null): string => (n === null ? '' : String(n));
const toCount = (text: string): number | null => {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : Math.max(0, n);
};

/** Resultado que sugieren los conteos: cualquier failed manda, luego blocked. */
function suggestedResult(counts: Record<CountField, string>): Result | null {
  if ((toCount(counts.failed) ?? 0) > 0) return 'failed';
  if ((toCount(counts.blocked) ?? 0) > 0) return 'blocked';
  if ((toCount(counts.passed) ?? 0) > 0) return 'passed';
  return null;
}

export function RunForm({ heading, initial, settings, onSubmit, onClose }: RunFormProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(initial);
  const [counts, setCounts] = useState<Record<CountField, string>>({
    passed: toText(initial.passed),
    failed: toText(initial.failed),
    blocked: toText(initial.blocked),
    bugs: toText(initial.bugs),
    minutes: toText(initial.minutes),
  });
  // Si el registro ya trae conteos (edición o duplicado) se respeta su resultado; si no, lo deciden los conteos hasta elegirlo a mano.
  const [resultTouched, setResultTouched] = useState(
    initial.passed !== null || initial.failed !== null || initial.blocked !== null,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const set = <K extends keyof TestRunInput>(key: K, value: TestRunInput[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setCount = (field: CountField, value: string): void => {
    const next = { ...counts, [field]: value };
    setCounts(next);
    if (!resultTouched) {
      const suggestion = suggestedResult(next);
      if (suggestion) set('result', suggestion);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const saved = await onSubmit({
      ...draft,
      title: draft.title.trim(),
      ticket: draft.ticket.trim().toUpperCase(),
      notes: draft.notes.trim(),
      passed: toCount(counts.passed),
      failed: toCount(counts.failed),
      blocked: toCount(counts.blocked),
      bugs: toCount(counts.bugs),
      minutes: toCount(counts.minutes),
    });
    if (saved) onClose();
    else setSaving(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  // El ambiente o tipo de un registro antiguo puede haberse quitado de los ajustes: se conserva como opción.
  const envs = draft.env && !settings.envs.includes(draft.env) ? [...settings.envs, draft.env] : settings.envs;
  const fromTicket = initial.ticket !== '' && initial.title !== '';

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="run-form-title">
      <form ref={formRef} onSubmit={submit} onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <div>
            <h2 id="run-form-title">{heading}</h2>
            {fromTicket && (
              <p className="hint">
                Para <b className="text-accent">{initial.ticket}</b> · {initial.title}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="fgrid">
          <label className="f full">
            Título / qué se probó
            <input
              required
              autoFocus={!fromTicket}
              placeholder="p. ej. Smoke post-deploy release 2.14"
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
            />
          </label>
          <label className="f">
            Tipo de test
            <select required value={draft.typeId} onChange={(e) => set('typeId', e.target.value)}>
              {settings.types.map((t) => (
                <option key={t.id} value={t.id}>{t.major ? '★ ' : ''}{t.name}</option>
              ))}
            </select>
          </label>
          <label className="f">
            Fecha
            <input type="date" required value={draft.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="f">
            Ticket (opcional)
            <input placeholder="ABC-1234" value={draft.ticket} onChange={(e) => set('ticket', e.target.value)} />
          </label>
          <label className="f">
            Ambiente
            <select value={draft.env} onChange={(e) => set('env', e.target.value)}>
              <option value="">—</option>
              {envs.map((env) => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="counts">
          <legend>Casos ejecutados <span className="hint">(opcional)</span></legend>
          <div className="fgrid3">
            {COUNT_FIELDS.map(([field, label, tone]) => (
              <label key={field} className={`f count${tone ? ` tone-${tone}` : ''}`}>
                {label}
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="0"
                  autoFocus={fromTicket && field === 'passed'}
                  value={counts[field]}
                  onChange={(e) => setCount(field, e.target.value)}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="f-group">
          <span className="f-label" id="result-label">Resultado</span>
          <div className="result-picker" role="radiogroup" aria-labelledby="result-label">
            {RESULTS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={draft.result === r}
                className={draft.result === r ? 'on' : ''}
                style={{ ['--tone' as string]: RESULT_META[r].color }}
                onClick={() => {
                  setResultTouched(true);
                  set('result', r);
                }}
              >
                <i />
                {RESULT_META[r].label}
              </button>
            ))}
          </div>
          {!resultTouched && <p className="hint">Se ajusta solo según los casos; elígelo a mano si hace falta.</p>}
        </div>

        <label className="f" style={{ marginTop: 14 }}>
          Notas
          <textarea rows={3} placeholder="Pasos, hallazgos, links a bugs…" value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <div className="actions">
          <span className="hint shortcut-hint"><Kbd>{MOD}↵</Kbd> guardar · <Kbd>Esc</Kbd> cancelar</span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar registro'}</button>
        </div>
      </form>
    </dialog>
  );
}
