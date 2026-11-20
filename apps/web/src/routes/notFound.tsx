import { t } from '../i18n/index.ts';

export function NotFoundPage() {
  return <div className="text-neutral-600 dark:text-neutral-400">{t('notFound.message')}</div>;
}
