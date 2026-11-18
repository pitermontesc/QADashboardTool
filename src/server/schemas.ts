import { z } from 'zod';
import { RESULTS } from '../shared/types.js';

const count = z.number().int().min(0).nullable().default(null);
const httpUrlOrEmpty = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Debe empezar con http:// o https://');

export const runInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
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
    .min(1, 'Debe quedar al menos un tipo de test'),
  envs: z.array(z.string().trim().min(1).max(40)).default([]),
  ticketBase: httpUrlOrEmpty.default(''),
});

export const backupSchema = settingsSchema.extend({ runs: z.array(runSchema) });

export const jiraConfigSchema = z.object({
  site: httpUrlOrEmpty,
  email: z.string().trim().max(200),
  jql: z.string().trim().max(2000),
  token: z.string().trim().max(500).optional(),
});
