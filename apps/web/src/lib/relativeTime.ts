import { t } from '../i18n/index.ts';
export function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return t('relativeTime.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('relativeTime.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('relativeTime.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('relativeTime.daysAgo', { count: day });
  return d.toLocaleDateString();
}
