import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBoth, type WidgetRow } from './render.ts';

const SKILL = fileURLToPath(new URL('../../../../plugins/primer/skills/primer/widgets.md', import.meta.url));

/** Each ```jsx module in the skill, with the ```json rows fence that follows it, if any. */
function skillModules(markdown: string): { name: string; source: string; rows: WidgetRow[] }[] {
  const fences = [...markdown.matchAll(/^### (.+)$|^```(jsx|json)\n([\s\S]*?)^```$/gm)];
  const modules: { name: string; source: string; rows: WidgetRow[] }[] = [];
  let heading = '';
  fences.forEach((m, i) => {
    if (m[1]) heading = m[1];
    if (m[2] !== 'jsx') return;
    const next = fences[i + 1];
    modules.push({ name: heading, source: m[3]!, rows: next?.[2] === 'json' ? (JSON.parse(next[3]!) as WidgetRow[]) : [] });
  });
  return modules;
}

describe('the widget skill', () => {
  const modules = skillModules(readFileSync(SKILL, 'utf8'));

  it('every skill template validates and renders', async () => {
    expect(modules.map((m) => m.name)).toEqual([
      'Flow: steps, a decision, a loop back',
      'Tree: a result and what drives it',
      '2×2: two axes, four quadrants, placed items',
      'Timeline: spans and milestones placed by date',
      'Funnel: each stage as wide as its count',
      'Roadmap: phases as equal bands',
      'Bar chart: one accent on the finding',
      'Line chart: a series against a target',
      'Area chart: a total and its share',
    ]);
    for (const { name, source, rows } of modules) {
      const out = await renderBoth(source, rows, 'w-');
      expect('errors' in out ? { name, errors: out.errors } : name).toBe(name);
      if (!('errors' in out)) expect(out.light.warnings).toEqual([]);
    }
  });
});
