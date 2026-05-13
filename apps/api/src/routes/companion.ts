import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION_PATH = join(HERE, '..', 'companion', 'v1.js');

export function registerCompanionRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/companion/v1.js', async (c) => {
    const body = await readFile(COMPANION_PATH, 'utf8');
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  });
}
