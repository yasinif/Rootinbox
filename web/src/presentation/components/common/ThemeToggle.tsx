/**
 * ThemeToggle — Sun/Moon toggle for light/dark theme switching.
 * Reads initial state from MetadataPort, falls back to prefers-color-scheme.
 * Persists choice via metadataPort.set('theme', 'light'|'dark').
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../../context';
import { SunIcon, MoonIcon } from './Icons';

function resolveCurrentTheme(): 'light' | 'dark' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const ThemeToggle: React.FC = () => {
  const { metadataPort } = useAppContext();
  const [theme, setTheme] = useState<'light' | 'dark'>(resolveCurrentTheme);

  useEffect(() => {
    // Sync with any external changes on mount
    setTheme(resolveCurrentTheme());
  }, []);

  const toggle = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    setTheme(next);
    metadataPort.set('theme', next).catch(() => {
      // Silently ignore persistence failures
    });
  }, [theme, metadataPort]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
    >
      {theme === 'light' ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    </button>
  );
};
