import { createContext, useContext } from 'react';
import type { Lang } from '../shared/types';

/**
 * Idioma de la interfaz. Cada componente declara sus textos en español e inglés
 * junto al código con `useText({ es: {...}, en: {...} })`; el inglés debe tener
 * las mismas claves y firmas que el español.
 */
const LangContext = createContext<Lang>('es');
export const LangProvider = LangContext.Provider;

export const useLang = (): Lang => useContext(LangContext);

export function useText<T>(texts: { es: T; en: NoInfer<T> }): T {
  return texts[useLang()];
}

/** Idioma inicial antes de cargar los ajustes: el del sistema. */
export const systemLang = (): Lang =>
  typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? 'en' : 'es';
