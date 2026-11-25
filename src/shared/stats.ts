import { addDays, shortLabel, startOfDay, toYmd } from './dates.js';
import { type Automation, type Lang, RESULTS, type Result, type TestRun } from './types.js';

/** Days back the dashboard covers; 0 = full history. */
export type Period = 7 | 30 | 90 | 0;

export type ResultCounts = Record<Result, number>;

const emptyCounts = (): ResultCounts => ({ passed: 0, failed: 0, blocked: 0, progress: 0 });

/** Most recent first; on the same date, the last created first. */
export function sortRuns(runs: readonly TestRun[]): TestRun[] {
  return [...runs].sort((a, b) =>
    a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1,
  );
}

/** The runs the dashboard's numbers and charts count: rehearsals (runs in test mode) stay out. */
export const countedRuns = (runs: readonly TestRun[]): TestRun[] => runs.filter((r) => !r.testMode);

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
  /** Percentage 0–100, or null if there is no data. */
  passRate: number | null;
  /** What the pass rate was computed on. */
  passRateBasis: 'cases' | 'runs' | 'none';
  passNumerator: number;
  passDenominator: number;
}

/** Jira keys of the bugs listed in each run's report (run id → keys), so a bug found in several runs counts once. */
export type BugKeysByRun = ReadonlyMap<string, readonly string[]>;

/** The Jira keys of each report's bugs, by the id of the run the report completed. */
export function bugKeysByRun(automations: readonly Pick<Automation, 'runId' | 'details'>[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of automations) {
    const keys = (a.details?.bugs ?? []).map((b) => b.key.trim().toUpperCase()).filter(Boolean);
    if (a.runId && keys.length > 0) map.set(a.runId, [...(map.get(a.runId) ?? []), ...keys]);
  }
  return map;
}

/**
 * The pass rate is computed over cases when case counts exist; otherwise over
 * finished runs (runs still in progress do not count).
 * Bugs: a Jira key listed by more than one report (the same bug on QA and on STG, or a smoke
 * repeated) counts once; bugs without a key are counted as each run reports them.
 */
export function summarize(runs: readonly TestRun[], bugKeys: BugKeysByRun = new Map()): Summary {
  let passed = 0, failed = 0, blocked = 0, bugs = 0, minutes = 0, runsPassed = 0, runsDone = 0;
  const seen = new Set<string>();
  for (const r of runs) {
    passed += r.passed ?? 0;
    failed += r.failed ?? 0;
    blocked += r.blocked ?? 0;
    let repeated = 0;
    for (const key of bugKeys.get(r.id) ?? []) {
      if (seen.has(key)) repeated++;
      else seen.add(key);
    }
    bugs += Math.max(0, (r.bugs ?? 0) - repeated);
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

/** One bucket per day for 7 and 30 days; per week (Monday to Sunday) for 90 days and "all". */
export function buildBuckets(runs: readonly TestRun[], period: Period, today: Date, lang: Lang = 'es'): Bucket[] {
  const t0 = startOfDay(today);
  const buckets: Bucket[] = [];
  const push = (from: Date, to: Date): void => {
    buckets.push({ from: toYmd(from), to: toYmd(to), label: shortLabel(from, lang), total: 0, counts: emptyCounts() });
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
