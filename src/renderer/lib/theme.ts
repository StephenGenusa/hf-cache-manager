import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';
export const THEME_KEY = 'hfcm.theme';

/** The stored theme; dark by default and whenever storage is unavailable or holds something else. */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark');
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // Storage can be blocked; the theme then lasts for this session only.
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = readTheme();
    document.documentElement.classList.toggle('dark', t === 'dark');
    return t;
  });
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  }, [theme]);
  return { theme, toggle };
}
