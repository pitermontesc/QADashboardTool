import { parseJiraBoardUrl } from '../shared/jiraBoard.js';
import { z } from 'zod';
import { LANGUAGES, RESULTS, STEP_STATUSES, THEMES, VERDICTS } from '../shared/types.js';
import { defaultQaConfig } from '../shared/orchestrator.js';

const count = z.number().int().min(0).nullable().default(null);

/*
 * What Claude reports is accepted more leniently than the form: a rejected report forces
 * Claude to fix and resend it, or it is lost. Numbers may come as text ("7"), long texts
 * are clipped and long lists are shortened.
 */
/** "7", " 2 ", "12.4" → number; "" → no value; any other text is kept so it fails. */
const numberFromText = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : value;
};
const reportedCount = z.preprocess(numberFromText, z.number().int().min(0).nullable()).default(null);
/** Minutes reported by Claude: decimals are accepted and rounded (anything that took time counts as 1 min). */
const reportedMinutes = z
  .preprocess(
    numberFromText,
    z
      .number()
      .min(0)
      .transform((v) => (v === 0 ? 0 : Math.max(1, Math.round(v))))
      .nullable(),
  )
  .default(null);
/** Text from Claude: anything over the limit is clipped with "…" instead of rejecting the report. */
const clip = (max: number) => (value: string): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const clipped = (max: number) => z.string().trim().transform(clip(max)).default('');
const clippedName = (max: number) => z.string().trim().min(1).transform(clip(max));
/** List from Claude: items over the limit are dropped instead of rejecting the report. */
const capped = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .transform((items) => items.slice(0, max))
    .default([]);
const httpUrlOrEmpty = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Must start with http:// or https://');

/** A YYYY-MM-DD that exists in the calendar (not 2026-02-30: Date would roll it over to March 2). */
const isRealDate = (value: string): boolean => {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export const runInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date').refine(isRealDate, 'Invalid date'),
  typeId: z.string().min(1),
  title: z.string().trim().min(1, 'Title is required').max(300),
  ticket: z.string().trim().max(60).default(''),
  env: z.string().trim().max(60).default(''),
  result: z.enum(RESULTS),
  passed: count,
  failed: count,
  blocked: count,
  bugs: count,
  minutes: count,
  notes: z.string().trim().max(5000).default(''),
  testMode: z.boolean().default(false),
});

export const runSchema = runInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.number().default(0),
});

/**
 * Sites and skills: they reach the Claude Code prompt as an argument (no shell), but
 * are validated anyway so only well-formed names, URLs and skill commands get through.
 */
const qaSiteSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,19}$/, 'The site id only allows lowercase letters, numbers and hyphens (e.g. stg)'),
  name: z.string().trim().min(1, 'The site needs a name').max(20).regex(/^[\p{L}\p{N} ._-]+$/u, 'The site name only allows letters, numbers, spaces, dots and hyphens'),
  url: z.string().trim().max(200).regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9\-._~/]*)?$/, 'The site URL must be http(s)://domain'),
  env: z.string().trim().min(1, 'The site needs an environment').max(40),
  jiraStatus: z.string().trim().max(40).default(''),
});
const skillSchema = z.string().trim().regex(/^\/[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/, 'A skill starts with / and only allows letters, numbers, “:”, “.”, “_” and “-”');
const qaConfigSchema = z
  .object({
    sites: z.array(qaSiteSchema).min(1, 'There must be at least one site').max(10),
    regressionSiteId: z.string(),
    skills: z.object({ orchestrator: skillSchema, smoke: skillSchema, regression: skillSchema }),
    testRunHosts: z
      .array(z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Invalid test run domain (e.g. testomat.io)'))
      .max(10)
      .default([]),
  })
  .refine((qa) => new Set(qa.sites.map((s) => s.id)).size === qa.sites.length, 'Several sites have the same id')
  .refine((qa) => {
    const statuses = qa.sites.map((s) => s.jiraStatus.toLowerCase()).filter(Boolean);
    return new Set(statuses).size === statuses.length;
  }, 'Two sites cannot use the same Jira status')
  .refine((qa) => qa.sites.some((s) => s.id === qa.regressionSiteId), 'The regression site must be one of the sites');

export const settingsSchema = z.object({
  types: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        major: z.boolean().default(false),
        color: z.string().regex(/^#[0-9a-f]{3,8}$/i, 'Invalid color'),
      }),
    )
    .min(1, 'At least one test type must remain')
    .refine((types) => new Set(types.map((t) => t.id)).size === types.length, 'There are repeated test types'),
  envs: z.array(z.string().trim().min(1).max(40)).default([]),
  ticketBase: httpUrlOrEmpty.default(''),
  language: z.enum(LANGUAGES).default('es'),
  theme: z.enum(THEMES).default('system'),
  qa: qaConfigSchema.default(defaultQaConfig),
});

export const backupSchema = settingsSchema
  // Runs from before v1.17.0 have no `testMode`: the import works it out from their reports.
  .extend({ runs: z.array(runSchema.extend({ testMode: z.boolean().optional() })), automations: z.lazy(() => z.array(storedAutomationSchema)).optional() })
  .refine((b) => b.runs.every((r) => b.types.some((t) => t.id === r.typeId)), 'The backup has runs of test types that do not exist')
  .refine((b) => new Set(b.runs.map((r) => r.id)).size === b.runs.length, 'The backup has two runs with the same id');

export const jiraConfigSchema = z.object({
  // https only: the Jira API token goes in every request.
  site: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https:\/\//i.test(v), 'The Jira site must start with https://'),
  email: z.string().trim().max(200),
  board: z
    .string()
    .trim()
    .max(4000)
    .refine((v) => v === '' || parseJiraBoardUrl(v) !== null, 'Not a Jira board link (…/boards/<number>)')
    .default(''),
  jql: z.string().trim().max(2000),
  token: z.string().trim().max(500).optional(),
});

/** "no go" → "NO-GO", "passed with findings" → "PASSED W/F", "incomplete" → "BLOCKED". */
function normalizeVerdict(raw: string): string {
  const v = raw.toUpperCase().replace(/[\s_]+/g, ' ').trim();
  if (/^NO[ -]?GO$/.test(v)) return 'NO-GO';
  if (/^PASSED (W\/F|WITH FINDINGS)$/.test(v)) return 'PASSED W/F';
  if (/^(INCOMPLETE|INCOMPLETO|NOT TESTED|SKIPPED)$/.test(v)) return 'BLOCKED';
  return v;
}

/** "PASS", "OK", "FAIL", "not tested"… → passed / failed / blocked / skipped. */
function normalizeStepStatus(raw: string): string {
  const v = raw.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (/^(pass|passed|ok|go|success)$/.test(v)) return 'passed';
  if (/^(fail|failed|error|no go|ko)$/.test(v)) return 'failed';
  if (/^(skip|skipped|not tested|not run|n\/a|na)$/.test(v)) return 'skipped';
  if (/^(block|blocked|incomplete)$/.test(v)) return 'blocked';
  return v;
}

const stepStatus = z
  .string()
  .trim()
  .transform(normalizeStepStatus)
  .pipe(z.enum(STEP_STATUSES, `The status must be one of: ${STEP_STATUSES.join(', ')}`));
/** Detailed QA report: one module per tested area with its steps, and the bugs found. */
export const automationDetailsSchema = z.object({
  build: clipped(200),
  modules: capped(
    z.object({
      name: clippedName(200),
      status: stepStatus,
      minutes: reportedMinutes,
      notes: clipped(2000),
      steps: capped(z.object({ name: clippedName(500), status: stepStatus, notes: clipped(2000) }), 500),
    }),
    100,
  ),
  bugs: capped(
    z.object({
      title: clippedName(300),
      severity: clipped(40),
      key: clipped(60),
      link: httpUrlOrEmpty.default(''),
      module: clipped(200),
    }),
    200,
  ),
  notes: clipped(5000),
  /** QA comment for Jira; if Claude could not post it, the app posts it with one click. */
  jiraComment: z
    .object({
      key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]+-\d+$/, 'The Jira ticket key is not valid (e.g. AVM-123)'),
      body: clippedName(30000),
      posted: z.boolean().default(false),
      url: httpUrlOrEmpty.default(''),
      dismissed: z.boolean().default(false),
    })
    .nullable()
    .default(null),
});

/** Bugs of a finished report, edited by the user in the language the report is shown in. */
export const reportBugsEditSchema = z.object({
  lang: z.enum(LANGUAGES),
  bugs: z
    .array(
      z.object({
        from: z.number().int().min(0).nullable().default(null),
        title: z.string().trim().min(1, 'Each bug needs a title').max(300),
        severity: z.string().trim().max(40).default(''),
        key: z.string().trim().toUpperCase().max(60).default(''),
        link: httpUrlOrEmpty.default(''),
        module: z.string().trim().max(200).default(''),
      }),
    )
    .max(200),
});

/** Translation returned by Claude: the summary and the report, with the same shape. */
export const reportTranslationSchema = z.object({
  summary: clipped(5000),
  details: automationDetailsSchema.omit({ jiraComment: true }).nullable().default(null),
});

/** Result Claude reports when it finishes a smoke, a regression or an orchestrator run. */
export const automationResultSchema = z.object({
  verdict: z
    .string()
    .trim()
    .transform(normalizeVerdict)
    .pipe(z.enum(VERDICTS, `The verdict must be one of: ${VERDICTS.join(', ')}`)),
  passed: reportedCount,
  failed: reportedCount,
  blocked: reportedCount,
  bugs: reportedCount,
  minutes: reportedMinutes,
  summary: clipped(5000),
  link: httpUrlOrEmpty.default(''),
  details: automationDetailsSchema.nullable().default(null),
});
export type AutomationResult = z.infer<typeof automationResultSchema>;

/** A QA report as saved, inside a backup. The process and its log belong to the machine that ran it, so they are not imported. */
const storedAutomationSchema = z.object({
  id: z.string().trim().min(1).max(100),
  kind: z.enum(['smoke', 'regression', 'orchestrator']),
  target: z.string().max(300),
  title: z.string().max(600),
  env: z.string().max(100),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  verdict: z.enum(VERDICTS).nullable(),
  summary: z.string().max(5000),
  link: httpUrlOrEmpty.default(''),
  details: automationDetailsSchema.nullable(),
  runId: z.string().max(100).nullable(),
  pid: z.unknown().transform(() => null),
  logFile: z.unknown().transform(() => ''),
  lang: z.enum(LANGUAGES),
  translations: z.partialRecord(z.enum(LANGUAGES), z.object({ summary: z.string().max(5000), details: automationDetailsSchema.nullable() })).default({}),
  dryRun: z.boolean().default(false),
  fullCoverage: z.boolean().default(false),
  site: z.string().max(100).default(''),
  ticketType: z.string().max(100).default(''),
  queued: z.object({ batch: z.string().max(100), retries: z.number().int().min(0).max(10) }).nullable().default(null),
});
