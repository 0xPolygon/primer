import { t } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../queries/me.ts';
import { api } from '../lib/fetch.ts';

export function UserMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!me.data) return null;

  async function signOut() {
    setOpen(false);
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span>{me.data.displayName}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 py-1 shadow-md"
        >
          <Link
            to="/settings/tokens"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {t('userMenu.apiTokens')}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {t('userMenu.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
