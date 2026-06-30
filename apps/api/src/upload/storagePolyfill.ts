// In-memory polyfill for `window.localStorage` / `window.sessionStorage`,
// injected as an inline <script> at the top of every uploaded artifact's
// <head>. See apps/api/src/upload/inject.ts (injectStoragePolyfill).
//
// Why: ArtifactIframe runs with sandbox="allow-scripts allow-forms
// allow-modals allow-downloads" — no `allow-same-origin`. In that
// opaque-origin context the `window.localStorage` getter itself throws
// SecurityError, before any `.getItem()` call. Artifacts that read
// storage at module top-level (defensive `|| fallback` and all) crash
// before their init can run. See issue #25.
//
// The shim is plain JS that the artifact can mutate freely; it grants
// no extra privileges and does NOT widen the sandbox. Storage is
// per-iframe-load only — no real persistence, no `storage` events,
// no cross-tab sync (none of which apply to opaque-origin iframes
// anyway).
export const STORAGE_POLYFILL_JS = `(function () {
  function makeStorage() {
    var map = new Map();
    function strKey(k) { return String(k); }
    return Object.freeze({
      get length() { return map.size; },
      key: function (i) {
        var n = Number(i);
        if (!isFinite(n) || n < 0 || n >= map.size) return null;
        var keys = Array.from(map.keys());
        return keys[Math.floor(n)];
      },
      getItem: function (k) {
        var key = strKey(k);
        return map.has(key) ? map.get(key) : null;
      },
      setItem: function (k, v) { map.set(strKey(k), String(v)); },
      removeItem: function (k) { map.delete(strKey(k)); },
      clear: function () { map.clear(); }
    });
  }
  try {
    Object.defineProperty(window, 'localStorage', {
      value: makeStorage(),
      writable: true, configurable: true, enumerable: true
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: makeStorage(),
      writable: true, configurable: true, enumerable: true
    });
  } catch (e) {
    // Browser refused to replace the descriptor. The artifact is no
    // worse off than before this polyfill existed.
  }
})();`;
