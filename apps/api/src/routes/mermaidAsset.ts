import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';
import { MERMAID_VERSION } from '../companion/mermaidVersion.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_FILENAME = `mermaid-v${MERMAID_VERSION}.js`;

// Two candidates because dev (tsx) runs from apps/api/src/routes/ while prod
// runs the bundled output from apps/api/dist/ where build.mjs copies the
// asset alongside it. Mirrors the dual-candidate pattern in companion.ts.
const BUNDLE_CANDIDATES = [
  join(HERE, '..', 'companion', BUNDLE_FILENAME),  // dev
  join(HERE, 'companion', BUNDLE_FILENAME),        // prod
];

let cachedBody: string | null = null;
async function loadBundle(): Promise<string> {
  if (cachedBody !== null) return cachedBody;
  for (const p of BUNDLE_CANDIDATES) {
    try {
      cachedBody = await readFile(p, 'utf8');
      return cachedBody;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `mermaid bundle not found in any candidate: ${BUNDLE_CANDIDATES.join(', ')}`,
  );
}

export function registerMermaidAssetRoute(
  app: Hono<{ Variables: AppVariables }>,
): void {
  app.get(`/companion/${BUNDLE_FILENAME}`, async (c) => {
    const body = await loadBundle();
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        // Versioned URL ⇒ safe to cache aggressively.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });
}
