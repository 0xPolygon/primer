import { useEffect } from 'react';

const SUFFIX = 'Primer';

/**
 * Sets document.title to `<title> · Primer`, or just `Primer` when title
 * is null/undefined (loading or root). Restores to plain `Primer` on
 * unmount so route changes that don't set their own title fall back
 * cleanly.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    const next = title && title.trim().length > 0 ? `${title} · ${SUFFIX}` : SUFFIX;
    const previous = document.title;
    document.title = next;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
