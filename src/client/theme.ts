import type { Theme } from '../shared/types';

/** Local copy of the theme, so it paints before settings respond (no light flash on open). */
const THEME_KEY = 'qa-dashboard-theme';

/** Applies the theme: `system` follows the OS mode; light or dark force it. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Without local storage the theme still applies.
  }
}

export function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // No local storage: automatic.
  }
  return 'system';
}

/** Header button cycle: Automatic → Light → Dark. */
export const nextTheme = (theme: Theme): Theme => (theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
