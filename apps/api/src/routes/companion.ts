import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two candidates because dev (tsx) runs this file from apps/api/src/routes/
// while prod runs the bundled output from apps/api/dist/ where build.mjs
// copies the companion asset alongside it.
const COMPANION_CANDIDATES = [
  join(HERE, '..', 'companion', 'v1.js'),  // dev: src/routes -> src/companion
  join(HERE, 'companion', 'v1.js'),        // prod: dist (bundled) -> dist/companion
];

let cachedBody: string | null = null;
async function loadCompanion(): Promise<string> {
  if (cachedBody !== null) return cachedBody;
  for (const p of COMPANION_CANDIDATES) {
    try {
      cachedBody = await readFile(p, 'utf8');
      return cachedBody;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `companion script not found in any candidate: ${COMPANION_CANDIDATES.join(', ')}`,
  );
}

export function registerCompanionRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/companion/v1.js', async (c) => {
    const body = await loadCompanion();
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  });
}
