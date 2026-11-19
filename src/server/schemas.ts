import { parseJiraBoardUrl } from '../shared/jiraBoard.js';
import { z } from 'zod';
import { LANGUAGES, RESULTS, STEP_STATUSES, THEMES, VERDICTS } from '../shared/types.js';

const count = z.number().int().min(0).nullable().default(null);
/** Minutos que reporta Claude: acepta decimales y los redondea (lo que dure algo cuenta como 1 min). */
const reportedMinutes = z
  .number()
  .min(0)
  .transform((v) => (v === 0 ? 0 : Math.max(1, Math.round(v))))
  .nullable()
  .default(null);
const httpUrlOrEmpty = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Debe empezar con http:// o https://');

/** YYYY-MM-DD que exista en el calendario (2026-02-30 no: Date lo pasaría al 2 de marzo). */
const isRealDate = (value: string): boolean => {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export const runInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').refine(isRealDate, 'Fecha inválida'),
  typeId: z.string().min(1),
  title: z.string().trim().min(1, 'El título es obligatorio').max(300),
  ticket: z.string().trim().max(60).default(''),
  env: z.string().trim().max(60).default(''),
  result: z.enum(RESULTS),
  passed: count,
  failed: count,
  blocked: count,
  bugs: count,
  minutes: count,
  notes: z.string().trim().max(5000).default(''),
});

export const runSchema = runInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.number().default(0),
});

export const settingsSchema = z.object({
  types: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        major: z.boolean().default(false),
        color: z.string().regex(/^#[0-9a-f]{3,8}$/i, 'Color inválido'),
      }),
    )
    .min(1, 'Debe quedar al menos un tipo de test')
    .refine((types) => new Set(types.map((t) => t.id)).size === types.length, 'Hay tipos de test repetidos'),
  envs: z.array(z.string().trim().min(1).max(40)).default([]),
  ticketBase: httpUrlOrEmpty.default(''),
  language: z.enum(LANGUAGES).default('es'),
  theme: z.enum(THEMES).default('system'),
});

export const backupSchema = settingsSchema
  .extend({ runs: z.array(runSchema) })
  .refine((b) => b.runs.every((r) => b.types.some((t) => t.id === r.typeId)), 'El respaldo tiene registros de tipos de test que no existen');

export const jiraConfigSchema = z.object({
  site: httpUrlOrEmpty,
  email: z.string().trim().max(200),
  board: z
    .string()
    .trim()
    .max(4000)
    .refine((v) => v === '' || parseJiraBoardUrl(v) !== null, 'No es un link de board de Jira (…/boards/<número>)')
    .default(''),
  jql: z.string().trim().max(2000),
  token: z.string().trim().max(500).optional(),
});

/** «no go» → «NO-GO», «passed with findings» → «PASSED W/F», «incomplete» → «BLOCKED». */
function normalizeVerdict(raw: string): string {
  const v = raw.toUpperCase().replace(/[\s_]+/g, ' ').trim();
  if (/^NO[ -]?GO$/.test(v)) return 'NO-GO';
  if (/^PASSED (W\/F|WITH FINDINGS)$/.test(v)) return 'PASSED W/F';
  if (/^(INCOMPLETE|INCOMPLETO|NOT TESTED|SKIPPED)$/.test(v)) return 'BLOCKED';
  return v;
}

/** «PASS», «OK», «FAIL», «not tested»… → passed / failed / blocked / skipped. */
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
  .pipe(z.enum(STEP_STATUSES, `El status debe ser uno de: ${STEP_STATUSES.join(', ')}`));
const text = (max: number) => z.string().trim().max(max).default('');

/** Reporte QA detallado: un módulo por área probada con sus pasos, y los bugs encontrados. */
export const automationDetailsSchema = z.object({
  build: text(200),
  modules: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        status: stepStatus,
        minutes: reportedMinutes,
        notes: text(2000),
        steps: z
          .array(z.object({ name: z.string().trim().min(1).max(500), status: stepStatus, notes: text(2000) }))
          .max(200)
          .default([]),
      }),
    )
    .max(60)
    .default([]),
  bugs: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        severity: text(40),
        key: text(60),
        link: httpUrlOrEmpty.default(''),
        module: text(200),
      }),
    )
    .max(100)
    .default([]),
  notes: text(5000),
  /** Comentario de QA para Jira; si Claude no pudo publicarlo, la app lo publica con un clic. */
  jiraComment: z
    .object({
      key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]+-\d+$/, 'La clave del ticket de Jira no es válida (p. ej. AVM-123)'),
      body: z.string().trim().min(1).max(30000),
      posted: z.boolean().default(false),
      url: httpUrlOrEmpty.default(''),
      dismissed: z.boolean().default(false),
    })
    .nullable()
    .default(null),
});

/** Traducción que devuelve Claude: el resumen y el reporte, con la misma forma. */
export const reportTranslationSchema = z.object({
  summary: z.string().trim().max(5000).default(''),
  details: automationDetailsSchema.omit({ jiraComment: true }).nullable().default(null),
});

/** Resultado que Claude reporta al terminar un smoke o una regresión. */
export const automationResultSchema = z.object({
  verdict: z
    .string()
    .trim()
    .transform(normalizeVerdict)
    .pipe(z.enum(VERDICTS, `El veredicto debe ser uno de: ${VERDICTS.join(', ')}`)),
  passed: count,
  failed: count,
  blocked: count,
  bugs: count,
  minutes: reportedMinutes,
  summary: z.string().trim().max(5000).default(''),
  link: httpUrlOrEmpty.default(''),
  details: automationDetailsSchema.nullable().default(null),
});
export type AutomationResult = z.infer<typeof automationResultSchema>;
