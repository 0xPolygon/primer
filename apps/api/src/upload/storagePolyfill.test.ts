// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { STORAGE_POLYFILL_JS } from './storagePolyfill.ts';

// Execute the polyfill source against the current jsdom window. After this
// runs, `window.localStorage` and `window.sessionStorage` are the in-memory
// shims, replacing jsdom's native ones. Mirrors how the inline <script>
// behaves inside an opaque-origin iframe in production.
function applyPolyfill(): void {
  // Function() with explicit `window` arg keeps the polyfill body decoupled
  // from this test file's lexical scope.
  new Function('window', STORAGE_POLYFILL_JS)(window);
}

describe('STORAGE_POLYFILL_JS', () => {
  beforeEach(() => {
    applyPolyfill();
  });

  it('exposes localStorage and sessionStorage as distinct objects', () => {
    expect(window.localStorage).toBeDefined();
    expect(window.sessionStorage).toBeDefined();
    expect(window.localStorage).not.toBe(window.sessionStorage);
  });

  it('getItem returns null for a missing key', () => {
    expect(window.localStorage.getItem('missing')).toBeNull();
  });

  it('setItem then getItem returns the stored value', () => {
    window.localStorage.setItem('k', 'v');
    expect(window.localStorage.getItem('k')).toBe('v');
  });

  it('setItem coerces non-string values to strings (Storage spec)', () => {
    window.localStorage.setItem('n', 1 as unknown as string);
    expect(window.localStorage.getItem('n')).toBe('1');
    window.localStorage.setItem('b', true as unknown as string);
    expect(window.localStorage.getItem('b')).toBe('true');
    window.localStorage.setItem(
      'o',
      { x: 1 } as unknown as string,
    );
    expect(window.localStorage.getItem('o')).toBe('[object Object]');
  });

  it('coerces non-string keys to strings', () => {
    window.localStorage.setItem(42 as unknown as string, 'hi');
    expect(window.localStorage.getItem('42')).toBe('hi');
    expect(window.localStorage.getItem(42 as unknown as string)).toBe('hi');
  });

  it('removeItem deletes a key and getItem then returns null', () => {
    window.localStorage.setItem('k', 'v');
    window.localStorage.removeItem('k');
    expect(window.localStorage.getItem('k')).toBeNull();
  });

  it('length reflects set / remove / clear', () => {
    expect(window.localStorage.length).toBe(0);
    window.localStorage.setItem('a', '1');
    window.localStorage.setItem('b', '2');
    expect(window.localStorage.length).toBe(2);
    window.localStorage.setItem('a', '3'); // overwrite, not new
    expect(window.localStorage.length).toBe(2);
    window.localStorage.removeItem('a');
    expect(window.localStorage.length).toBe(1);
    window.localStorage.clear();
    expect(window.localStorage.length).toBe(0);
  });

  it('key(i) returns the key at index i, null for out-of-range', () => {
    window.localStorage.setItem('a', '1');
    window.localStorage.setItem('b', '2');
    expect(window.localStorage.key(0)).toBe('a');
    expect(window.localStorage.key(1)).toBe('b');
    expect(window.localStorage.key(2)).toBeNull();
    expect(window.localStorage.key(-1)).toBeNull();
    expect(window.localStorage.key('foo' as unknown as number)).toBeNull();
  });

  it('localStorage and sessionStorage do not share state', () => {
    window.localStorage.setItem('shared', 'local');
    window.sessionStorage.setItem('shared', 'session');
    expect(window.localStorage.getItem('shared')).toBe('local');
    expect(window.sessionStorage.getItem('shared')).toBe('session');
    window.localStorage.clear();
    expect(window.sessionStorage.getItem('shared')).toBe('session');
  });

  it('the artifact line from issue #25 evaluates without throwing', () => {
    // Verbatim from Marketing-DevRel-BvA-offline.html:542 —
    //   let polPrice = parseFloat(localStorage.getItem('pol_price') || '0.09') || 0.09;
    // With no `pol_price` set, this MUST evaluate to 0.09.
    const polPrice =
      parseFloat(window.localStorage.getItem('pol_price') || '0.09') || 0.09;
    expect(polPrice).toBe(0.09);
  });

  it('returned Storage methods are not clobberable (frozen)', () => {
    expect(() => {
      // Strict-mode assignment to a frozen property would throw; in non-strict
      // it silently fails. Either way, the original method must survive.
      try {
        (window.localStorage as unknown as { getItem: unknown }).getItem =
          () => 'evil';
      } catch {
        /* frozen — expected */
      }
    }).not.toThrow();
    window.localStorage.setItem('k', 'v');
    expect(window.localStorage.getItem('k')).toBe('v');
  });
});
