import type { Theme } from '../shared/types';

/** Copia local del tema, para pintarlo antes de que respondan los ajustes (sin destello claro al abrir). */
const THEME_KEY = 'qa-dashboard-theme';

/** Aplica el tema: `system` deja que mande el modo del sistema; claro u oscuro lo fuerzan. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Sin almacenamiento local el tema igual se aplica.
  }
}

export function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Sin almacenamiento local: automático.
  }
  return 'system';
}

/** Orden del botón de la cabecera: Automático → Claro → Oscuro. */
export const nextTheme = (theme: Theme): Theme => (theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
