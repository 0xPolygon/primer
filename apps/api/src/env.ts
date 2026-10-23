import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from this file looking for a .env. Works whether this script is
// running from src/ (tsx dev) or apps/api/dist/db/ (compiled). Silently
// no-ops in production where env vars are injected directly.
function findUpEnv(start: string, maxDepth = 12): string | null {
  let dir = start;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const envPath = findUpEnv(dirname(fileURLToPath(import.meta.url)));
if (envPath) {
  config({ path: envPath, quiet: true });
}
