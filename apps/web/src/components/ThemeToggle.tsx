import { t } from '../i18n/index.ts';
import { useTheme, type Preference } from '../lib/useTheme.ts';

const NEXT: Record<Preference, Preference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const LABEL: Record<Preference, string> = {
  light: t('themeToggle.light'),
  dark: t('themeToggle.dark'),
  system: t('themeToggle.system'),
};

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = preference === 'light' ? SunIcon : preference === 'dark' ? MoonIcon : SystemIcon;

  return (
    <button
      type="button"
      onClick={() => setPreference(NEXT[preference])}
      aria-label={LABEL[preference]}
      title={LABEL[preference]}
      className="flex h-7 w-7 items-center justify-center rounded text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <Icon />
    </button>
  );
}
