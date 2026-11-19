import { useEffect, useMemo, useState } from 'react';
import { resultLabel } from '../../shared/defaults';
import { useLang, useText } from '../i18n';
import { EMPTY_FILTERS, filterRuns, isResult, sortRuns, type RunFilters } from '../../shared/stats';
import { RESULTS, type AppState, type Automation, type TestRun } from '../../shared/types';
import { Icon } from './icons';
import { RunsTable } from './ui';

interface RunsViewProps {
  state: AppState;
  onEdit: (run: TestRun) => void;
  onDuplicate: (run: TestRun) => void;
  onDelete: (run: TestRun) => void;
  onOpenReport: (automation: Automation) => void;
}

const CONFIRM_WINDOW_MS = 3000;

const TEXT = {
  es: {
    search: 'Buscar título, ticket o notas…  ( / )', searchLabel: 'Buscar registros',
    allTypes: 'Todos los tipos', allEnvs: 'Todos los ambientes', allResults: 'Todos los resultados',
    from: 'Desde', to: 'Hasta', count: (n: number, total: number) => `${n} de ${total} registros`,
    clear: 'Limpiar filtros', report: 'Reporte', edit: 'Editar', duplicate: 'Duplicar', confirm: '¿Confirmar?', remove: 'Borrar',
  },
  en: {
    search: 'Search title, ticket or notes…  ( / )', searchLabel: 'Search runs',
    allTypes: 'All types', allEnvs: 'All environments', allResults: 'All results',
    from: 'From', to: 'To', count: (n: number, total: number) => `${n} of ${total} runs`,
    clear: 'Clear filters', report: 'Report', edit: 'Edit', duplicate: 'Duplicate', confirm: 'Confirm?', remove: 'Delete',
  },
};

export function RunsView({ state, onEdit, onDuplicate, onDelete, onOpenReport }: RunsViewProps) {
  const { settings, runs } = state;
  const lang = useLang();
  const t = useText(TEXT);
  const automationByRun = new Map(state.automations.filter((a) => a.runId).map((a) => [a.runId!, a]));
  const [filters, setFilters] = useState<RunFilters>(EMPTY_FILTERS);
  /** Run whose deletion awaits a second confirming click. */
  const [armedId, setArmedId] = useState<string | null>(null);

  useEffect(() => {
    if (armedId === null) return;
    const timer = setTimeout(() => setArmedId(null), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armedId]);

  const rows = useMemo(() => filterRuns(sortRuns(runs), filters), [runs, filters]);
  const set = <K extends keyof RunFilters>(key: K, value: RunFilters[K]): void =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <section>
      <div className="filters">
        <label className="search">
          <Icon name="search" />
          <input
            id="runs-search"
            placeholder={t.search}
            aria-label={t.searchLabel}
            value={filters.query}
            onChange={(e) => set('query', e.target.value)}
          />
        </label>
        <select value={filters.typeId} onChange={(e) => set('typeId', e.target.value)}>
          <option value="">{t.allTypes}</option>
          {settings.types.map((t) => (
            <option key={t.id} value={t.id}>{t.major ? '★ ' : ''}{t.name}</option>
          ))}
        </select>
        <select value={filters.env} onChange={(e) => set('env', e.target.value)}>
          <option value="">{t.allEnvs}</option>
          {settings.envs.map((env) => (
            <option key={env} value={env}>{env}</option>
          ))}
        </select>
        <select value={filters.result} onChange={(e) => set('result', isResult(e.target.value) ? e.target.value : '')}>
          <option value="">{t.allResults}</option>
          {RESULTS.map((r) => (
            <option key={r} value={r}>{resultLabel(r, lang)}</option>
          ))}
        </select>
        <input type="date" title={t.from} value={filters.from} onChange={(e) => set('from', e.target.value)} />
        <input type="date" title={t.to} value={filters.to} onChange={(e) => set('to', e.target.value)} />
      </div>
      <div className="row">
        <span className="hint">{t.count(rows.length, runs.length)}</span>
        <div className="spacer" />
        {JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS) && (
          <button className="link" onClick={() => setFilters(EMPTY_FILTERS)}>{t.clear}</button>
        )}
      </div>
      <div className="card">
        <div className="tablewrap">
          <RunsTable
            runs={rows}
            settings={settings}
            actions={(run) => (
              <>
                {/* Icons with their accessible name also in the tooltip: they fit on one line at any width. */}
                {automationByRun.has(run.id) && (
                  <button className="icon-btn" title={t.report} aria-label={t.report} onClick={() => onOpenReport(automationByRun.get(run.id)!)}>
                    <Icon name="eye" size={15} />
                  </button>
                )}
                <button className="icon-btn" title={t.edit} aria-label={t.edit} onClick={() => onEdit(run)}>
                  <Icon name="edit" size={15} />
                </button>
                <button className="icon-btn" title={t.duplicate} aria-label={t.duplicate} onClick={() => onDuplicate(run)}>
                  <Icon name="copy" size={15} />
                </button>
                <button
                  className={armedId === run.id ? 'link danger' : 'icon-btn danger'}
                  title={armedId === run.id ? undefined : t.remove}
                  aria-label={armedId === run.id ? t.confirm : t.remove}
                  onClick={() => {
                    if (armedId === run.id) {
                      setArmedId(null);
                      onDelete(run);
                    } else {
                      setArmedId(run.id);
                    }
                  }}
                >
                  {armedId === run.id ? t.confirm : <Icon name="trash" size={15} />}
                </button>
              </>
            )}
          />
        </div>
      </div>
    </section>
  );
}
