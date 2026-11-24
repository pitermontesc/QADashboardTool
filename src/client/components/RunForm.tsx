import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RESULT_META, resultLabel } from '../../shared/defaults';
import { useLang, useText } from '../i18n';
import { RESULTS, type Result, type Settings, type TestRunInput } from '../../shared/types';
import { Icon } from './icons';
import { Kbd, MOD, useModalDialog } from './ui';

interface RunFormProps {
  heading: string;
  initial: TestRunInput;
  settings: Settings;
  onSubmit: (input: TestRunInput) => Promise<boolean>;
  onClose: () => void;
}

const COUNT_FIELDS = [
  ['passed', 'ok'],
  ['failed', 'bad'],
  ['blocked', 'warn'],
  ['bugs', 'bad'],
  ['minutes', ''],
] as const;

const TEXT = {
  es: {
    counts: { passed: 'Casos passed', failed: 'Casos failed', blocked: 'Casos blocked', bugs: 'Bugs', minutes: 'Minutos' },
    forTicket: 'Para', close: 'Cerrar', title: 'Título / qué se probó', titlePh: 'p. ej. Smoke post-deploy release 2.14',
    type: 'Tipo de test', date: 'Fecha', ticket: 'Ticket (opcional)', env: 'Ambiente',
    casesRun: 'Casos ejecutados', optional: '(opcional)', result: 'Resultado',
    autoHint: 'Se ajusta solo según los casos; elígelo a mano si hace falta.',
    notes: 'Notas', notesPh: 'Pasos, hallazgos, links a bugs…', save: 'guardar', cancelKey: 'cancelar',
    cancel: 'Cancelar', saving: 'Guardando…', saveRun: 'Guardar registro',
  },
  en: {
    counts: { passed: 'Cases passed', failed: 'Cases failed', blocked: 'Cases blocked', bugs: 'Bugs', minutes: 'Minutes' },
    forTicket: 'For', close: 'Close', title: 'Title / what was tested', titlePh: 'e.g. Post-deploy smoke release 2.14',
    type: 'Test type', date: 'Date', ticket: 'Ticket (optional)', env: 'Environment',
    casesRun: 'Cases executed', optional: '(optional)', result: 'Result',
    autoHint: 'Set automatically from the cases; pick it by hand if needed.',
    notes: 'Notes', notesPh: 'Steps, findings, bug links…', save: 'save', cancelKey: 'cancel',
    cancel: 'Cancel', saving: 'Saving…', saveRun: 'Save run',
  },
};
type CountField = (typeof COUNT_FIELDS)[number][0];

const toText = (n: number | null): string => (n === null ? '' : String(n));
const toCount = (text: string): number | null => {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : Math.max(0, n);
};

/** Result suggested by the counts: any failed wins, then blocked. */
function suggestedResult(counts: Record<CountField, string>): Result | null {
  if ((toCount(counts.failed) ?? 0) > 0) return 'failed';
  if ((toCount(counts.blocked) ?? 0) > 0) return 'blocked';
  if ((toCount(counts.passed) ?? 0) > 0) return 'passed';
  return null;
}

export function RunForm({ heading, initial, settings, onSubmit, onClose }: RunFormProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const dialog = useModalDialog();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(initial);
  const [counts, setCounts] = useState<Record<CountField, string>>({
    passed: toText(initial.passed),
    failed: toText(initial.failed),
    blocked: toText(initial.blocked),
    bugs: toText(initial.bugs),
    minutes: toText(initial.minutes),
  });
  // If the run already has counts (edit or duplicate) its result is kept; otherwise the counts decide it until it is picked by hand.
  const [resultTouched, setResultTouched] = useState(
    initial.passed !== null || initial.failed !== null || initial.blocked !== null,
  );
  const [saving, setSaving] = useState(false);

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

  // An old run's environment or type may have been removed from settings: keep it as an option.
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
                {t.forTicket} <b className="text-accent">{initial.ticket}</b> · {initial.title}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="fgrid">
          <label className="f full">
            {t.title}
            <input
              required
              autoFocus={!fromTicket}
              placeholder={t.titlePh}
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
            />
          </label>
          <label className="f">
            {t.type}
            <select required value={draft.typeId} onChange={(e) => set('typeId', e.target.value)}>
              {settings.types.map((t) => (
                <option key={t.id} value={t.id}>{t.major ? '★ ' : ''}{t.name}</option>
              ))}
            </select>
          </label>
          <label className="f">
            {t.date}
            <input type="date" required value={draft.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="f">
            {t.ticket}
            <input placeholder="ABC-1234" value={draft.ticket} onChange={(e) => set('ticket', e.target.value)} />
          </label>
          <label className="f">
            {t.env}
            <select value={draft.env} onChange={(e) => set('env', e.target.value)}>
              <option value="">—</option>
              {envs.map((env) => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="counts">
          <legend>{t.casesRun} <span className="hint">{t.optional}</span></legend>
          <div className="fgrid3">
            {COUNT_FIELDS.map(([field, tone]) => (
              <label key={field} className={`f count${tone ? ` tone-${tone}` : ''}`}>
                {t.counts[field]}
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
          <span className="f-label" id="result-label">{t.result}</span>
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
                {resultLabel(r, lang)}
              </button>
            ))}
          </div>
          {!resultTouched && <p className="hint">{t.autoHint}</p>}
        </div>

        <label className="f" style={{ marginTop: 14 }}>
          {t.notes}
          <textarea rows={3} placeholder={t.notesPh} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <div className="actions">
          <span className="hint shortcut-hint"><Kbd>{MOD}↵</Kbd> {t.save} · <Kbd>Esc</Kbd> {t.cancelKey}</span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? t.saving : t.saveRun}</button>
        </div>
      </form>
    </dialog>
  );
}
