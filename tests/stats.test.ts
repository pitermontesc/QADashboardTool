import { describe, expect, it } from 'vitest';
import {
  buildBuckets, countByTicket, countByType, EMPTY_FILTERS, filterByPeriod, filterRuns, lastRunByType, sortRuns, summarize,
} from '../src/shared/stats';
import type { TestRun } from '../src/shared/types';

const TODAY = new Date(2026, 10, 17); // martes 17/11/2026

let seq = 0;
function run(overrides: Partial<TestRun>): TestRun {
  seq++;
  return {
    id: `r${seq}`, createdAt: seq, date: '2026-11-17', typeId: 't0', title: `Run ${seq}`, ticket: '', env: 'QA',
    result: 'passed', passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '', ...overrides,
  };
}

describe('summarize', () => {
  it('calcula el pass rate sobre casos cuando hay conteos', () => {
    const s = summarize([
      run({ passed: 20, failed: 0 }),
      run({ result: 'failed', passed: 80, failed: 5, blocked: 0, bugs: 3, minutes: 90 }),
    ]);
    expect(s).toMatchObject({ executions: 2, cases: 105, passRate: 95, passRateBasis: 'cases', bugs: 3, minutes: 90 });
  });

  it('usa ejecuciones terminadas cuando no hay conteos de casos', () => {
    const s = summarize([run({}), run({ result: 'failed' }), run({ result: 'progress' })]);
    expect(s).toMatchObject({ passRate: 50, passRateBasis: 'runs', passNumerator: 1, passDenominator: 2 });
  });

  it('devuelve null sin datos', () => {
    expect(summarize([]).passRate).toBeNull();
    expect(summarize([run({ result: 'progress' })]).passRateBasis).toBe('none');
  });
});

describe('filterByPeriod', () => {
  const runs = [run({ date: '2026-11-17' }), run({ date: '2026-11-11' }), run({ date: '2026-11-10' }), run({ date: '2025-01-01' })];

  it('incluye hoy y los N-1 días anteriores', () => {
    expect(filterByPeriod(runs, 7, TODAY).map((r) => r.date)).toEqual(['2026-11-17', '2026-11-11']);
  });

  it('0 devuelve todo el historial', () => {
    expect(filterByPeriod(runs, 0, TODAY)).toHaveLength(4);
  });
});

describe('buildBuckets', () => {
  it('crea un bucket por día y cuenta por resultado', () => {
    const buckets = buildBuckets([run({}), run({ result: 'failed' }), run({ date: '2026-11-16', result: 'blocked' })], 7, TODAY);
    expect(buckets).toHaveLength(7);
    expect(buckets.at(-1)).toMatchObject({ from: '2026-11-17', total: 2, counts: { passed: 1, failed: 1 } });
    expect(buckets.at(-2)).toMatchObject({ total: 1, counts: { blocked: 1 } });
    expect(buckets[0]?.from).toBe('2026-11-11');
  });

  it('agrupa por semanas de lunes a domingo en períodos largos', () => {
    const buckets = buildBuckets([run({ date: '2026-11-15' }), run({ date: '2026-11-16' })], 90, TODAY);
    expect(buckets).toHaveLength(13);
    expect(buckets.at(-1)).toMatchObject({ from: '2026-11-16', to: '2026-11-22', total: 1 });
    expect(buckets.at(-2)).toMatchObject({ from: '2026-11-09', to: '2026-11-15', total: 1 });
    expect(buildBuckets([], 0, TODAY)).toHaveLength(26);
  });
});

describe('agrupaciones', () => {
  const runs = [
    run({ typeId: 'smoke', date: '2026-11-10', ticket: 'AVM-1' }),
    run({ typeId: 'smoke', date: '2026-11-15', ticket: 'AVM-1', result: 'failed' }),
    run({ typeId: 'api', date: '2026-11-12' }),
  ];

  it('ordena por fecha descendente', () => {
    expect(sortRuns(runs).map((r) => r.date)).toEqual(['2026-11-15', '2026-11-12', '2026-11-10']);
  });

  it('cuenta por tipo, de mayor a menor', () => {
    expect(countByType(runs)).toEqual([
      { typeId: 'smoke', total: 2, counts: { passed: 1, failed: 1, blocked: 0, progress: 0 } },
      { typeId: 'api', total: 1, counts: { passed: 1, failed: 0, blocked: 0, progress: 0 } },
    ]);
  });

  it('encuentra la última ejecución de cada tipo', () => {
    expect(lastRunByType(runs).get('smoke')?.date).toBe('2026-11-15');
  });

  it('cuenta registros por ticket ignorando los vacíos', () => {
    expect([...countByTicket(runs)]).toEqual([['AVM-1', 2]]);
  });

  it('filtra por texto, tipo, resultado y fechas', () => {
    expect(filterRuns(runs, { ...EMPTY_FILTERS, query: 'avm-1', result: 'failed' })).toHaveLength(1);
    expect(filterRuns(runs, { ...EMPTY_FILTERS, typeId: 'api' })).toHaveLength(1);
    expect(filterRuns(runs, { ...EMPTY_FILTERS, from: '2026-11-11', to: '2026-11-13' })).toHaveLength(1);
    expect(filterRuns(runs, EMPTY_FILTERS)).toHaveLength(3);
  });
});
