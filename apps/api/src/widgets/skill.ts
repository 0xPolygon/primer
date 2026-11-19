import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(HERE, '..', '..', '..', '..', 'plugins', 'primer', 'skills', 'primer', 'widgets.md'), // dev: src/widgets
  join(HERE, 'skills', 'widgets.md'), // prod: dist (copied by scripts/build.mjs)
];

export const WIDGET_SKILL_URI = 'primer://skills/widgets';

let cached: string | null = null;

/** The widget skill (plugins/primer/skills/primer/widgets.md): rules, house
 *  style and copyable modules, served to agents as an MCP resource. */
export async function widgetSkill(): Promise<string> {
  if (cached !== null) return cached;
  for (const path of CANDIDATES) {
    try {
      cached = await readFile(path, 'utf8');
      return cached;
    } catch {
      /* try the next location */
    }
  }
  throw new Error('widgets.md not found');
}
