import type { Lang, Result, Settings } from './types.js';

export const PALETTE = [
  '#2f5bd8', '#8b5cf6', '#0e9aa7', '#e0672b', '#c2410c', '#be185d', '#4d7c0f',
  '#0369a1', '#a16207', '#6d28d9', '#0f766e', '#b91c1c', '#475569', '#9d174d',
] as const;

export const RESULT_META: Record<Result, { label: string; color: string }> = {
  passed: { label: 'Passed', color: 'var(--ok)' },
  failed: { label: 'Failed', color: 'var(--bad)' },
  blocked: { label: 'Blocked', color: 'var(--warn)' },
  progress: { label: 'En progreso', color: 'var(--prog)' },
};

/** Nombre del resultado en el idioma de la interfaz (Passed/Failed/Blocked son términos de QA y no se traducen). */
export function resultLabel(result: Result, lang: Lang): string {
  return result === 'progress' && lang === 'en' ? 'In progress' : RESULT_META[result].label;
}

export const DEFAULT_JQL = 'assignee WAS currentUser() AND updated >= -14d ORDER BY updated DESC';

const DEFAULT_TYPES: ReadonlyArray<readonly [name: string, major: boolean]> = [
  ['Smoke', true],
  ['Regression', true],
  ['Funcional', false],
  ['Exploratorio', false],
  ['Re-test / Verificación de bug', false],
  ['Sanity', false],
  ['Integración', false],
  ['End-to-End', false],
  ['API', false],
  ['Performance', false],
  ['Seguridad', false],
  ['Usabilidad', false],
  ['Accesibilidad', false],
  ['UAT', false],
];

export function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

export function defaultSettings(): Settings {
  return {
    types: DEFAULT_TYPES.map(([name, major], i) => ({ id: `t${i}`, name, major, color: colorForIndex(i) })),
    envs: ['QA', 'STG', 'PROD', 'Local'],
    ticketBase: '',
    language: 'es',
  };
}
