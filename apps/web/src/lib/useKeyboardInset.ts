import { useEffect, useState } from 'react';

/**
 * Returns the number of pixels at the bottom of the layout viewport currently
 * obscured by the on-screen keyboard (or other UA chrome). Zero when no
 * keyboard is up, or when the UA honors `interactive-widget=resizes-content`
 * (in which case `window.innerHeight` already equals `visualViewport.height`).
 *
 * Defensive: if `visualViewport` is unavailable (very old UAs), returns 0
 * permanently — the sheet will be hidden behind the keyboard on those, which
 * is the degraded behavior we accept per the design spec.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      const obscured = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(obscured)));
    };
    compute();
    vv.addEventListener('resize', compute);
    vv.addEventListener('scroll', compute);
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);

  return inset;
}
