import { defineConfig } from 'vitest/config';

// Real-browser test tier (`pnpm test:browser`). jsdom dispatches every event
// via dispatchEvent() on one synchronous JS stack, so it CANNOT represent
// real UA input dispatch — where a microtask checkpoint runs after every
// listener callback. That divergence let a consent-gate design pass 18/18
// jsdom tests while refusing 100% of legitimate submissions in a real
// browser (drill finding, 2026-08-26). Guarantees that only this tier
// proves: legit sync-in-gesture forwarding, deferred-submit refusal, and
// one-tap-one-forward under genuine trusted input.
//
// Deliberately OUTSIDE the default `pnpm test` run: it launches an
// installed Google Chrome via playwright-core (no browser download, no DB),
// which CI runners and fresh clones may not have. Run it locally — and in
// any environment with Chrome — whenever v1.js's consent gate changes.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.browser.test.ts'],
    coverage: { enabled: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
