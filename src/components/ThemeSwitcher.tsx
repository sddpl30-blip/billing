import React, { useEffect, useState } from 'react';

type Theme = 'emerald' | 'ivory';
const KEY = 'mani-vista-ui-theme';

/** The preference affects presentation only; financial data remains server-owned. */
export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return window.localStorage.getItem(KEY) === 'ivory' ? 'ivory' : 'emerald'; }
    catch { return 'emerald'; }
  });
  useEffect(() => {
    document.documentElement.dataset.mvTheme = theme;
    try { window.localStorage.setItem(KEY, theme); } catch { /* private browsing */ }
  }, [theme]);
  return <div role="group" aria-label="Appearance" className="mv-theme-switcher">
    <button type="button" aria-pressed={theme === 'emerald'} onClick={() => setTheme('emerald')} className={theme === 'emerald' ? 'selected' : ''}>Emerald</button>
    <button type="button" aria-pressed={theme === 'ivory'} onClick={() => setTheme('ivory')} className={theme === 'ivory' ? 'selected' : ''}>Ivory</button>
  </div>;
}
