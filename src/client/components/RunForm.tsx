import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RESULT_META } from '../../shared/defaults';
import { RESULTS, type Result, type Settings, type TestRunInput } from '../../shared/types';

interface RunFormProps {
  heading: string;
  initial: TestRunInput;
  settings: Settings;
  onSubmit: (input: TestRunInput) => Promise<boolean>;
  onClose: () => void;
}

const COUNT_FIELDS = [
  ['passed', 'Casos passed'],
  ['failed', 'Casos failed'],
  ['blocked', 'Casos blocked'],
  ['bugs', 'Bugs'],
  ['minutes', 'Minutos'],
] as const;
type CountField = (typeof COUNT_FIELDS)[number][0];

const toText = (n: number | null): string => (n === null ? '' : String(n));
const toCount = (text: string): number | null => {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : Math.max(0, n);
};

export function RunForm({ heading, initial, settings, onSubmit, onClose }: RunFormProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [counts, setCounts] = useState<Record<CountField, string>>({
    passed: toText(initial.passed),
    failed: toText(initial.failed),
    blocked: toText(initial.blocked),
    bugs: toText(initial.bugs),
    minutes: toText(initial.minutes),
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const set = <K extends keyof TestRunInput>(key: K, value: TestRunInput[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
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

  // El ambiente o tipo de un registro antiguo puede haberse quitado de los ajustes: se conserva como opción.
  const envs = draft.env && !settings.envs.includes(draft.env) ? [...settings.envs, draft.env] : settings.envs;

  return (
    <dialog ref={dialog} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{heading}</h2>
        <div className="fgrid">
          <label className="f">
            Fecha
            <input type="date" required value={draft.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="f">
            Tipo de test
            <select required value={draft.typeId} onChange={(e) => set('typeId', e.target.value)}>
              {settings.types.map((t) => (
                <option key={t.id} value={t.id}>{t.major ? '★ ' : ''}{t.name}</option>
              ))}
            </select>
          </label>
          <label className="f full">
            Título / qué se probó
            <input
              required
              autoFocus
              placeholder="p. ej. Smoke post-deploy release 2.14"
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
            />
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
          <label className="f full">
            Resultado
            <select value={draft.result} onChange={(e) => set('result', e.target.value as Result)}>
              {RESULTS.map((r) => (
                <option key={r} value={r}>{RESULT_META[r].label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="fgrid3" style={{ marginTop: 12 }}>
          {COUNT_FIELDS.map(([field, label]) => (
            <label key={field} className="f">
              {label}
              <input
                type="number"
                min={0}
                value={counts[field]}
                onChange={(e) => setCounts((c) => ({ ...c, [field]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <label className="f" style={{ marginTop: 12 }}>
          Notas
          <textarea rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={saving}>Guardar</button>
        </div>
      </form>
    </dialog>
  );
}
