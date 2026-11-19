import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSync from '@jitl/quickjs-wasmfile-release-sync';
import type { WidgetError } from './parse.ts';

/** Bounds on one render. The sandbox has no host functions at all: rows and
 *  tokens go in as a JSON string and the tree comes out as one. */
export const RUN_LIMITS = {
  timeMs: 50,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  nodes: 5000,
  /** Largest tree JSON the host parses (the SVG itself is capped at 512 KB). */
  outputChars: 4 * 1024 * 1024,
};

/** What `__h` builds: an element, or a text node (a string). */
export type WidgetNode = string | { t: string; p: Record<string, unknown>; c: WidgetNode[] };

let quickjs: Promise<QuickJSWASMModule> | null = null;

/** The WASM module, instantiated once per process (outside any render's time budget). */
function engine(): Promise<QuickJSWASMModule> {
  quickjs ??= newQuickJSWASMModuleFromVariant(releaseSync);
  return quickjs;
}

// One line, prepended to the module's first line, so error lines are the
// module's own. `__h` counts elements and refuses past the node bound; the
// clock and random numbers are removed, so a module draws the same every time
// (a publish re-renders the draft and must get the preview's hash).
const PRELUDE = [
  '"use strict";',
  `const __Fragment = {}; let __count = 0;`,
  `const __flat = (items, out) => { for (const item of items) { if (Array.isArray(item)) __flat(item, out); else if (item === null || item === undefined || item === false || item === true) continue; else if (typeof item === "number") out.push(String(item)); else out.push(item); } return out; };`,
  `const __h = (tag, props, ...children) => { const c = __flat(children, []); if (tag === __Fragment) return c; if (typeof tag === "function") return tag(Object.assign({}, props, { children: c })); if (typeof tag !== "string") throw new TypeError("A JSX tag must be an SVG element name or a component function."); if (++__count > ${RUN_LIMITS.nodes}) throw new RangeError("The drawing has more than ${RUN_LIMITS.nodes} elements."); return { t: tag, p: props === null ? {} : Object.assign({}, props), c }; };`,
  `Math.random = () => { throw new Error("Math.random is not available: a widget draws the same every time."); };`,
  `{ const D = Date; globalThis.Date = class extends D { constructor(...a) { if (a.length === 0) throw new Error("new Date() reads the clock: a widget draws the same every time."); super(...a); } static now() { throw new Error("Date.now() reads the clock: a widget draws the same every time."); } }; }`,
].join(' ');

/**
 * Runs a compiled widget (`parseWidget(...).code`) in a fresh QuickJS runtime:
 * 16 MB of memory, 50 ms of time, a bounded stack and at most 5,000 elements.
 */
export async function runWidget(
  code: string,
  input: { rows: unknown[]; tokens: Record<string, string> },
): Promise<{ tree: WidgetNode } | { errors: WidgetError[] }> {
  const module = await engine();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(RUN_LIMITS.memoryBytes);
  runtime.setMaxStackSize(RUN_LIMITS.stackBytes);
  const context = runtime.newContext();
  try {
    const epilogue = `\n;JSON.stringify(__render(JSON.parse(${JSON.stringify(JSON.stringify(input))})));`;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + RUN_LIMITS.timeMs));
    const result = context.evalCode(PRELUDE + code + epilogue, 'widget.js');
    if (result.error) {
      const error = context.dump(result.error) as { name?: string; message?: string; stack?: string } | string;
      result.error.dispose();
      return { errors: [runtimeError(error)] };
    }
    const json = context.getString(result.value);
    result.value.dispose();
    if (typeof json !== 'string' || json.length > RUN_LIMITS.outputChars) {
      return { errors: [{ line: 1, message: 'The widget returned nothing drawable, or far too much.', fix: 'Return one <svg> element from render().' }] };
    }
    return { tree: JSON.parse(json) as WidgetNode };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function runtimeError(error: { name?: string; message?: string; stack?: string } | string): WidgetError {
  if (typeof error === 'string' || !error) {
    return { line: 1, message: String(error), fix: 'Fix the error and draft again.' };
  }
  const message = error.message ?? String(error);
  const line = Number(/widget\.js:(\d+)/.exec(error.stack ?? '')?.[1] ?? 1);
  if (message === 'interrupted') {
    return { line, message: `Rendering took longer than ${RUN_LIMITS.timeMs} ms.`, fix: 'Draw less, or loop less: precompute nothing expensive per element.' };
  }
  if (/out of memory/i.test(message)) {
    return { line, message: 'Rendering ran out of memory (16 MB).', fix: 'Draw fewer elements or use fewer rows.' };
  }
  return { line, message: `${error.name ?? 'Error'}: ${message}`, fix: 'Fix the error and draft again.' };
}
