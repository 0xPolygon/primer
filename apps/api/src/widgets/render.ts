import { createHash } from 'node:crypto';
import type { WidgetError } from './parse.ts';
import { runWidget } from './run.ts';
import { serializeSvg, type SerializedSvg } from './serialize.ts';
import { inspectWidget } from './validate.ts';

export type WidgetTheme = 'light' | 'dark';

/**
 * The theme tokens a widget colours with; nothing else is a colour. Values
 * follow the page's palette (Tailwind neutral, with 600/400 accents), so a
 * widget reads in both themes without the agent picking colours.
 */
export const WIDGET_TOKENS: Record<WidgetTheme, Record<string, string>> = {
  light: {
    fg: '#171717', muted: '#525252', surface: '#ffffff', grid: '#e5e5e5', axis: '#737373', neutral: '#a3a3a3',
    accent1: '#2563eb', accent2: '#ea580c', accent3: '#7c3aed', accent4: '#0d9488', accent5: '#db2777', accent6: '#ca8a04',
    good: '#16a34a', warn: '#d97706', bad: '#dc2626',
  },
  dark: {
    fg: '#e5e5e5', muted: '#a3a3a3', surface: '#171717', grid: '#262626', axis: '#737373', neutral: '#525252',
    accent1: '#60a5fa', accent2: '#fb923c', accent3: '#a78bfa', accent4: '#2dd4bf', accent5: '#f472b6', accent6: '#facc15',
    good: '#4ade80', warn: '#fbbf24', bad: '#f87171',
  },
};

/** A row a widget draws from. `id` is its stable identity (a record id for a
 *  collection), so a comment on a mark stays on its row when rows re-sort. */
export type WidgetRow = Record<string, unknown> & { id: string | number };

export const MAX_ROWS = 2000;

/** Row problems, or null: every row is an object with a unique `id`. */
export function checkRows(rows: unknown): WidgetError[] | null {
  const fix = 'Pass rows as an array of objects, each with a unique `id` (string or number).';
  if (!Array.isArray(rows)) return [{ line: 0, message: 'rows must be an array.', fix }];
  if (rows.length > MAX_ROWS) return [{ line: 0, message: `At most ${MAX_ROWS} rows.`, fix: 'Aggregate the rows first.' }];
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof row !== 'object' || row === null || Array.isArray(row) || (typeof id !== 'string' && typeof id !== 'number')) {
      return [{ line: 0, message: `Row ${i} has no id.`, fix }];
    }
    if (seen.has(String(id))) return [{ line: 0, message: `Two rows have id "${String(id)}".`, fix }];
    seen.add(String(id));
  }
  return null;
}

/**
 * Validates, runs and serializes a widget module for one theme. The static
 * check and the runtime output check both run on every render.
 */
export async function renderWidget(
  source: string,
  rows: WidgetRow[],
  theme: WidgetTheme,
  opts: { idPrefix?: string } = {},
): Promise<SerializedSvg | { errors: WidgetError[] }> {
  const rowErrors = checkRows(rows);
  if (rowErrors) return { errors: rowErrors };
  const inspected = inspectWidget(source);
  if (inspected.errors.length > 0 || !inspected.parsed) return { errors: inspected.errors };
  const tokens = WIDGET_TOKENS[theme];
  const ran = await runWidget(inspected.parsed.code, { rows, tokens });
  if ('errors' in ran) return ran;
  return serializeSvg(ran.tree, {
    colours: new Set(Object.values(tokens)),
    rows: new Map(rows.map((row) => [String(row.id), row])),
    textIds: new Set(inspected.labels.keys()),
    idPrefix: opts.idPrefix ?? 'w-',
  });
}

/** Both themes, or the first theme's errors. */
export async function renderBoth(
  source: string,
  rows: WidgetRow[],
  idPrefix: string,
): Promise<{ light: SerializedSvg; dark: SerializedSvg; hash: string } | { errors: WidgetError[] }> {
  const light = await renderWidget(source, rows, 'light', { idPrefix });
  if ('errors' in light) return light;
  const dark = await renderWidget(source, rows, 'dark', { idPrefix });
  if ('errors' in dark) return dark;
  return { light, dark, hash: previewHash(light.svg, dark.svg) };
}

/** Ids in a widget's SVG get this prefix, so two widgets on a page never collide. */
export function widgetIdPrefix(widgetId: string): string {
  return `wg${widgetId.replace(/-/g, '').slice(-12)}-`;
}

/** What a publish is bound to: the light and dark SVG the agent previewed. */
export function previewHash(light: string, dark: string): string {
  return createHash('sha256').update(light).update('\n').update(dark).digest('hex');
}
