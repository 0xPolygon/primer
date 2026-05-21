import { useCallback, useEffect, useState } from 'react';

export type Preference = 'light' | 'dark' | 'system';
export type Effective = 'light' | 'dark';

const STORAGE_KEY = 'primer.theme';

function readPreference(): Preference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage unavailable */
  }
  return 'system';
}

function computeEffective(preference: Preference): Effective {
  if (preference === 'light' || preference === 'dark') return preference;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyEffective(effective: Effective) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', effective === 'dark');
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<Preference>(readPreference);
  const [effective, setEffective] = useState<Effective>(() => computeEffective(readPreference()));

  useEffect(() => {
    applyEffective(effective);
  }, [effective]);

  useEffect(() => {
    setEffective(computeEffective(preference));
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setEffective(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback((next: Preference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  return { preference, effective, setPreference };
}
