import { useEffect, useMemo, useState } from 'react';
import { RESULT_META } from '../../shared/defaults';
import { EMPTY_FILTERS, filterRuns, isResult, sortRuns, type RunFilters } from '../../shared/stats';
import { RESULTS, type AppState, type TestRun } from '../../shared/types';
import { Icon } from './icons';
import { RunsTable } from './ui';

interface RunsViewProps {
  state: AppState;
  onEdit: (run: TestRun) => void;
  onDuplicate: (run: TestRun) => void;
  onDelete: (run: TestRun) => void;
}

const CONFIRM_WINDOW_MS = 3000;

export function RunsView({ state, onEdit, onDuplicate, onDelete }: RunsViewProps) {
  const { settings, runs } = state;
  const [filters, setFilters] = useState<RunFilters>(EMPTY_FILTERS);
  /** Registro cuyo borrado espera un segundo clic de confirmación. */
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
            placeholder="Buscar título, ticket o notas…  ( / )"
            aria-label="Buscar registros"
            value={filters.query}
            onChange={(e) => set('query', e.target.value)}
          />
        </label>
        <select value={filters.typeId} onChange={(e) => set('typeId', e.target.value)}>
          <option value="">Todos los tipos</option>
          {settings.types.map((t) => (
            <option key={t.id} value={t.id}>{t.major ? '★ ' : ''}{t.name}</option>
          ))}
        </select>
        <select value={filters.env} onChange={(e) => set('env', e.target.value)}>
          <option value="">Todos los ambientes</option>
          {settings.envs.map((env) => (
            <option key={env} value={env}>{env}</option>
          ))}
        </select>
        <select value={filters.result} onChange={(e) => set('result', isResult(e.target.value) ? e.target.value : '')}>
          <option value="">Todos los resultados</option>
          {RESULTS.map((r) => (
            <option key={r} value={r}>{RESULT_META[r].label}</option>
          ))}
        </select>
        <input type="date" title="Desde" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        <input type="date" title="Hasta" value={filters.to} onChange={(e) => set('to', e.target.value)} />
      </div>
      <div className="row">
        <span className="hint">{rows.length} de {runs.length} registros</span>
        <div className="spacer" />
        {JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS) && (
          <button className="link" onClick={() => setFilters(EMPTY_FILTERS)}>Limpiar filtros</button>
        )}
      </div>
      <div className="card">
        <div className="tablewrap">
          <RunsTable
            runs={rows}
            settings={settings}
            actions={(run) => (
              <>
                <button className="link" onClick={() => onEdit(run)}>Editar</button>
                <button className="link" onClick={() => onDuplicate(run)}>Duplicar</button>
                <button
                  className="link danger"
                  onClick={() => {
                    if (armedId === run.id) {
                      setArmedId(null);
                      onDelete(run);
                    } else {
                      setArmedId(run.id);
                    }
                  }}
                >
                  {armedId === run.id ? '¿Confirmar?' : 'Borrar'}
                </button>
              </>
            )}
          />
        </div>
      </div>
    </section>
  );
}
