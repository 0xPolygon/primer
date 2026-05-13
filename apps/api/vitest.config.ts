import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testing/setup.ts'],
    coverage: { enabled: false },
    // Force every test against the separate test database (see design spec).
    // The db client module reads DATABASE_URL at import time; vitest sets these
    // before any test file is loaded, so this guarantees no test ever talks to
    // the dev database.
    env: {
      DATABASE_URL: 'postgres://primer:primer@localhost:5432/primer_test',
    },
    // Test files share the primer_test DB. The truncate-between-tests setup
    // can't isolate concurrent files. Serialize file execution to keep
    // semantics simple and deterministic.
    fileParallelism: false,
  },
});
