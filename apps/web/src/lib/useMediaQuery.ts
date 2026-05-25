import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns `false` during SSR / pre-mount
 * (Primer is a Vite SPA, so this only matters for the very first paint).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    // Re-read in case the value changed between render and subscribe.
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
