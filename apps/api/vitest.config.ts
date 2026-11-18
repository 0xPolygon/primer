import { defineConfig, configDefaults } from 'vitest/config';

// Two modes, selected by TEST_BASE_URL.
//
// The shared `docker-test` release action boots the built image and runs
// `TEST_BASE_URL=http://localhost:3000 pnpm --filter api test` against it. The
// in-process suite below imports the app directly and truncates a local
// database, so it cannot target a container. When TEST_BASE_URL is set we
// therefore run a small separate suite (`container-tests/`) that only talks
// HTTP. This deliberately differs from the template, where the same tests run
// in both modes. The container suite lives outside `src/` so the default glob
// can never pick it up.
const containerMode = Boolean(process.env.TEST_BASE_URL);

// The same variable `pnpm db:migrate:test` reads, so tests run against the
// database that was just migrated. The fallback matches docker-compose.yml's
// default credentials, so `pnpm db:up` is all a fresh clone needs. The setup
// file truncates tables before every test, so refuse anything that isn't a
// `_test` database rather than risk wiping a dev database.
function testDatabaseUrl(): string {
  const url =
    process.env.DATABASE_URL_TEST ?? 'postgres://primer:primer_local_dev@localhost:5432/primer_test';
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`DATABASE_URL_TEST must name a *_test database; got "${dbName}"`);
  }
  return url;
}

// TEST_BASE_URL is also the team's prod-smoke variable, so a value left in a
// shell would otherwise silently swap the 71-file suite for the smoke suite.
if (containerMode) {
  console.log(`TEST_BASE_URL is set: running the container smoke suite against ${process.env.TEST_BASE_URL}`);
}

export default defineConfig(
  containerMode
    ? {
        test: {
          globals: false,
          environment: 'node',
          include: ['container-tests/**/*.test.ts'],
          coverage: { enabled: false },
        },
      }
    : {
        test: {
          globals: false,
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // The real-browser tier needs an installed Chrome and runs via
          // `pnpm test:browser` (vitest.browser.config.ts) — see that file for
          // why it exists and why it is not part of the default run.
          exclude: [...configDefaults.exclude, 'src/**/*.browser.test.ts'],
          setupFiles: ['src/testing/setup.ts'],
          coverage: { enabled: false },
          // Force every test against the separate test database (see design spec).
          // The db client module reads DATABASE_URL at import time; vitest sets these
          // before any test file is loaded, so this guarantees no test ever talks to
          // the dev database.
          env: {
            DATABASE_URL: testDatabaseUrl(),
          },
          // Test files share the primer_test DB. The truncate-between-tests setup
          // can't isolate concurrent files. Serialize file execution to keep
          // semantics simple and deterministic.
          fileParallelism: false,
        },
      },
);
