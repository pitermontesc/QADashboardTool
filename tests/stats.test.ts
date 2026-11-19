import { describe, expect, it } from 'vitest';
import {
  buildBuckets, countByTicket, countByType, EMPTY_FILTERS, filterByPeriod, filterRuns, lastRunByType, sortRuns, summarize,
} from '../src/shared/stats';
import type { TestRun } from '../src/shared/types';

const TODAY = new Date(2026, 10, 17); // Tuesday 2026-11-17

let seq = 0;
function run(overrides: Partial<TestRun>): TestRun {
  seq++;
  return {
    id: `r${seq}`, createdAt: seq, date: '2026-11-17', typeId: 't0', title: `Run ${seq}`, ticket: '', env: 'QA',
    result: 'passed', passed: null, failed: null, blocked: null, bugs: null, minutes: null, notes: '', ...overrides,
  };
}

describe('summarize', () => {
  it('computes the pass rate over cases when counts exist', () => {
    const s = summarize([
      run({ passed: 20, failed: 0 }),
      run({ result: 'failed', passed: 80, failed: 5, blocked: 0, bugs: 3, minutes: 90 }),
    ]);
    expect(s).toMatchObject({ executions: 2, cases: 105, passRate: 95, passRateBasis: 'cases', bugs: 3, minutes: 90 });
  });

  it('uses finished runs when there are no case counts', () => {
    const s = summarize([run({}), run({ result: 'failed' }), run({ result: 'progress' })]);
    expect(s).toMatchObject({ passRate: 50, passRateBasis: 'runs', passNumerator: 1, passDenominator: 2 });
  });

  it('returns null without data', () => {
    expect(summarize([]).passRate).toBeNull();
    expect(summarize([run({ result: 'progress' })]).passRateBasis).toBe('none');
  });
});

describe('filterByPeriod', () => {
  const runs = [run({ date: '2026-11-17' }), run({ date: '2026-11-11' }), run({ date: '2026-11-10' }), run({ date: '2025-01-01' })];

  it('includes today and the previous N-1 days', () => {
    expect(filterByPeriod(runs, 7, TODAY).map((r) => r.date)).toEqual(['2026-11-17', '2026-11-11']);
  });

  it('0 returns the full history', () => {
    expect(filterByPeriod(runs, 0, TODAY)).toHaveLength(4);
  });
});

describe('buildBuckets', () => {
  it('creates one bucket per day and counts by result', () => {
    const buckets = buildBuckets([run({}), run({ result: 'failed' }), run({ date: '2026-11-16', result: 'blocked' })], 7, TODAY);
    expect(buckets).toHaveLength(7);
    expect(buckets.at(-1)).toMatchObject({ from: '2026-11-17', total: 2, counts: { passed: 1, failed: 1 } });
    expect(buckets.at(-2)).toMatchObject({ total: 1, counts: { blocked: 1 } });
    expect(buckets[0]?.from).toBe('2026-11-11');
  });

  it('groups by Monday-to-Sunday weeks for long periods', () => {
    const buckets = buildBuckets([run({ date: '2026-11-15' }), run({ date: '2026-11-16' })], 90, TODAY);
    expect(buckets).toHaveLength(13);
    expect(buckets.at(-1)).toMatchObject({ from: '2026-11-16', to: '2026-11-22', total: 1 });
    expect(buckets.at(-2)).toMatchObject({ from: '2026-11-09', to: '2026-11-15', total: 1 });
    expect(buildBuckets([], 0, TODAY)).toHaveLength(26);
  });
});

describe('groupings', () => {
  const runs = [
    run({ typeId: 'smoke', date: '2026-11-10', ticket: 'AVM-1' }),
    run({ typeId: 'smoke', date: '2026-11-15', ticket: 'AVM-1', result: 'failed' }),
    run({ typeId: 'api', date: '2026-11-12' }),
  ];

  it('sorts by date descending', () => {
    expect(sortRuns(runs).map((r) => r.date)).toEqual(['2026-11-15', '2026-11-12', '2026-11-10']);
  });

  it('counts by type, highest first', () => {
    expect(countByType(runs)).toEqual([
      { typeId: 'smoke', total: 2, counts: { passed: 1, failed: 1, blocked: 0, progress: 0 } },
      { typeId: 'api', total: 1, counts: { passed: 1, failed: 0, blocked: 0, progress: 0 } },
    ]);
  });

  it('finds the latest run of each type', () => {
    expect(lastRunByType(runs).get('smoke')?.date).toBe('2026-11-15');
  });

  it('counts runs per ticket, ignoring empty ones', () => {
    expect([...countByTicket(runs)]).toEqual([['AVM-1', 2]]);
  });

  it('filters by text, type, result and dates', () => {
    expect(filterRuns(runs, { ...EMPTY_FILTERS, query: 'avm-1', result: 'failed' })).toHaveLength(1);
    expect(filterRuns(runs, { ...EMPTY_FILTERS, typeId: 'api' })).toHaveLength(1);
    expect(filterRuns(runs, { ...EMPTY_FILTERS, from: '2026-11-11', to: '2026-11-13' })).toHaveLength(1);
    expect(filterRuns(runs, EMPTY_FILTERS)).toHaveLength(3);
  });
});
