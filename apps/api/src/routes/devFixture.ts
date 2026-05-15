import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', 'companion', 'fixtures', 'anchoring.html');

export function registerDevFixtureRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/dev/fixtures/anchoring.html', async (c) => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const transformed = transformHtml(raw);
    if (!transformed.ok) {
      return c.json({ error: 'fixture_parse_failed', message: transformed.message }, 500);
    }
    return new Response(transformed.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      },
    });
  });
}
