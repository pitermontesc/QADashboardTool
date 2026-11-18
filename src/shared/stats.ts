import { addDays, shortLabel, startOfDay, toYmd } from './dates.js';
import { RESULTS, type Result, type TestRun } from './types.js';

/** Días hacia atrás que cubre el dashboard; 0 = todo el historial. */
export type Period = 7 | 30 | 90 | 0;

export type ResultCounts = Record<Result, number>;

const emptyCounts = (): ResultCounts => ({ passed: 0, failed: 0, blocked: 0, progress: 0 });

/** Más recientes primero; a igual fecha, el último creado primero. */
export function sortRuns(runs: readonly TestRun[]): TestRun[] {
  return [...runs].sort((a, b) =>
    a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1,
  );
}

export function filterByPeriod(runs: readonly TestRun[], period: Period, today: Date): TestRun[] {
  if (period === 0) return [...runs];
  const from = toYmd(addDays(startOfDay(today), -(period - 1)));
  return runs.filter((r) => r.date >= from);
}

export interface Summary {
  executions: number;
  cases: number;
  passed: number;
  failed: number;
  blocked: number;
  bugs: number;
  minutes: number;
  /** Porcentaje 0–100, o null si no hay datos. */
  passRate: number | null;
  /** Sobre qué se calculó el pass rate. */
  passRateBasis: 'cases' | 'runs' | 'none';
  passNumerator: number;
  passDenominator: number;
}

/**
 * El pass rate se calcula sobre casos cuando hay conteos de casos; si no,
 * sobre ejecuciones terminadas (las que siguen en progreso no cuentan).
 */
export function summarize(runs: readonly TestRun[]): Summary {
  let passed = 0, failed = 0, blocked = 0, bugs = 0, minutes = 0, runsPassed = 0, runsDone = 0;
  for (const r of runs) {
    passed += r.passed ?? 0;
    failed += r.failed ?? 0;
    blocked += r.blocked ?? 0;
    bugs += r.bugs ?? 0;
    minutes += r.minutes ?? 0;
    if (r.result !== 'progress') {
      runsDone++;
      if (r.result === 'passed') runsPassed++;
    }
  }
  const cases = passed + failed + blocked;
  const base = { executions: runs.length, cases, passed, failed, blocked, bugs, minutes };
  if (cases > 0) {
    return { ...base, passRate: Math.round((passed / cases) * 100), passRateBasis: 'cases', passNumerator: passed, passDenominator: cases };
  }
  if (runsDone > 0) {
    return { ...base, passRate: Math.round((runsPassed / runsDone) * 100), passRateBasis: 'runs', passNumerator: runsPassed, passDenominator: runsDone };
  }
  return { ...base, passRate: null, passRateBasis: 'none', passNumerator: 0, passDenominator: 0 };
}

export interface Bucket {
  from: string;
  to: string;
  label: string;
  total: number;
  counts: ResultCounts;
}

/** Un bucket por día para 7 y 30 días; por semana (lunes a domingo) para 90 días y "todo". */
export function buildBuckets(runs: readonly TestRun[], period: Period, today: Date): Bucket[] {
  const t0 = startOfDay(today);
  const buckets: Bucket[] = [];
  const push = (from: Date, to: Date): void => {
    buckets.push({ from: toYmd(from), to: toYmd(to), label: shortLabel(from), total: 0, counts: emptyCounts() });
  };
  if (period === 7 || period === 30) {
    for (let i = period - 1; i >= 0; i--) {
      const day = addDays(t0, -i);
      push(day, day);
    }
  } else {
    const weeks = period === 90 ? 13 : 26;
    const monday = addDays(t0, -((t0.getDay() + 6) % 7));
    for (let i = weeks - 1; i >= 0; i--) {
      const start = addDays(monday, -7 * i);
      push(start, addDays(start, 6));
    }
  }
  for (const r of runs) {
    const bucket = buckets.find((b) => r.date >= b.from && r.date <= b.to);
    if (bucket) {
      bucket.counts[r.result]++;
      bucket.total++;
    }
  }
  return buckets;
}

export interface TypeCount {
  typeId: string;
  total: number;
  counts: ResultCounts;
}

export function countByType(runs: readonly TestRun[]): TypeCount[] {
  const map = new Map<string, TypeCount>();
  for (const r of runs) {
    let entry = map.get(r.typeId);
    if (!entry) {
      entry = { typeId: r.typeId, total: 0, counts: emptyCounts() };
      map.set(r.typeId, entry);
    }
    entry.total++;
    entry.counts[r.result]++;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function lastRunByType(runs: readonly TestRun[]): Map<string, TestRun> {
  const last = new Map<string, TestRun>();
  for (const r of sortRuns(runs)) {
    if (!last.has(r.typeId)) last.set(r.typeId, r);
  }
  return last;
}

export function countByTicket(runs: readonly TestRun[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of runs) {
    if (r.ticket) counts.set(r.ticket, (counts.get(r.ticket) ?? 0) + 1);
  }
  return counts;
}

export interface RunFilters {
  query: string;
  typeId: string;
  env: string;
  result: Result | '';
  from: string;
  to: string;
}

export const EMPTY_FILTERS: RunFilters = { query: '', typeId: '', env: '', result: '', from: '', to: '' };

export function filterRuns(runs: readonly TestRun[], f: RunFilters): TestRun[] {
  const q = f.query.trim().toLowerCase();
  return runs.filter((r) => {
    if (f.typeId && r.typeId !== f.typeId) return false;
    if (f.env && r.env !== f.env) return false;
    if (f.result && r.result !== f.result) return false;
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    return !q || `${r.title} ${r.ticket} ${r.notes}`.toLowerCase().includes(q);
  });
}

export const isResult = (value: string): value is Result => (RESULTS as readonly string[]).includes(value);
