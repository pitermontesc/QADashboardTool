import { createContext, useContext } from 'react';
import type { Lang } from '../shared/types';

/**
 * UI language. Each component declares its Spanish and English texts next to
 * the code with `useText({ es: {...}, en: {...} })`; the English entry must have
 * the same keys and signatures as the Spanish one.
 */
const LangContext = createContext<Lang>('es');
export const LangProvider = LangContext.Provider;

export const useLang = (): Lang => useContext(LangContext);

export function useText<T>(texts: { es: T; en: NoInfer<T> }): T {
  return texts[useLang()];
}

/** Initial language before settings load: the system's. */
export const systemLang = (): Lang =>
  typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? 'en' : 'es';
