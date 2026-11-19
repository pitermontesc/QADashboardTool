import type { Lang, Result, Settings } from './types.js';
import { defaultQaConfig } from './orchestrator.js';

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

/** Tipos de test por defecto, en español e inglés; al cambiar de idioma se traducen los que no se editaron. */
export const DEFAULT_TYPES: ReadonlyArray<readonly [es: string, en: string, major: boolean]> = [
  ['Smoke', 'Smoke', true],
  ['Regression', 'Regression', true],
  ['Funcional', 'Functional', false],
  ['Exploratorio', 'Exploratory', false],
  ['Re-test / Verificación de bug', 'Re-test / Bug verification', false],
  ['Sanity', 'Sanity', false],
  ['Integración', 'Integration', false],
  ['End-to-End', 'End-to-End', false],
  ['API', 'API', false],
  ['Performance', 'Performance', false],
  ['Seguridad', 'Security', false],
  ['Usabilidad', 'Usability', false],
  ['Accesibilidad', 'Accessibility', false],
  ['UAT', 'UAT', false],
];

export function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

export function defaultSettings(language: Lang = 'es'): Settings {
  return {
    types: DEFAULT_TYPES.map(([es, en, major], i) => ({ id: `t${i}`, name: language === 'en' ? en : es, major, color: colorForIndex(i) })),
    envs: ['QA', 'STG', 'PROD', 'Local'],
    ticketBase: '',
    language,
    theme: 'system',
    qa: defaultQaConfig(),
  };
}

/** Tipos por defecto en el idioma elegido; los que el usuario renombró quedan como están. */
export function localizeTypes(types: Settings['types'], lang: Lang): Settings['types'] {
  return types.map((type) => {
    const match = /^t(\d+)$/.exec(type.id);
    const names = match ? DEFAULT_TYPES[Number(match[1])] : undefined;
    return names && (type.name === names[0] || type.name === names[1]) ? { ...type, name: lang === 'en' ? names[1] : names[0] } : type;
  });
}

/** Idioma probable de un texto de Claude (para reportes guardados antes de que se registrara el idioma). */
export function guessLang(text: string): Lang {
  const es = (text.match(/[áéíóúñ¿¡]|\b(de|del|los|las|el|en|con|sin|para|que|una?|pasos?|se|no)\b/gi) ?? []).length;
  const en = (text.match(/\b(the|of|and|with|without|for|to|is|are|was|steps?|not|no)\b/gi) ?? []).length;
  return es > en ? 'es' : 'en';
}
