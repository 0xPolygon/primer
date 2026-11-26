import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { SVG_LIMITS, WIDGET_FONT, useInstances } from './serialize.ts';
import { WIDGET_TOKENS, type WidgetTheme } from './render.ts';

export const MAX_RASTER_PX = 2048;

const FACES = ['Regular', 'Medium', 'Bold'];
let fontFiles: string[] | null = null;

/**
 * The widget font as TrueType files resvg can load (the Node binding takes
 * only file paths). Roboto (Apache-2.0) ships as WOFF in `roboto-fontface`,
 * which the page loads too, so the server and the page draw with the same
 * face. WOFF 1.0 is the sfnt tables, each zlib-compressed; this unpacks them
 * once per process into a private directory of its own (mkdtemp: unique
 * name, owner-only), created afresh and removed at exit.
 */
function widgetFontFiles(): string[] {
  if (fontFiles) return fontFiles;
  const require = createRequire(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'primer-widget-fonts-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  fontFiles = FACES.map((face) => {
    const out = join(dir, `${WIDGET_FONT}-${face}.ttf`);
    const woff = readFileSync(require.resolve(`roboto-fontface/fonts/roboto/${WIDGET_FONT}-${face}.woff`));
    writeFileSync(out, woffToSfnt(woff), { flag: 'wx', mode: 0o600 });
    return out;
  });
  return fontFiles;
}

/** Decodes a WOFF 1.0 file to the sfnt (TrueType/OpenType) it wraps. */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 font');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = Array.from({ length: numTables }, (_, i) => {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    return {
      tag: woff.subarray(at, at + 4),
      checksum: woff.readUInt32BE(at + 16),
      data: compLength < origLength ? inflateSync(raw) : raw,
    };
  });
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  const chunks: Buffer[] = [header];
  let offset = header.length;
  tables.forEach((table, i) => {
    const at = 12 + i * 16;
    table.tag.copy(header, at);
    header.writeUInt32BE(table.checksum, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(table.data.length, at + 12);
    const padded = Buffer.alloc((table.data.length + 3) & ~3);
    table.data.copy(padded);
    chunks.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(chunks);
}

/**
 * A PNG of a serialized widget SVG on the theme's surface: 1× its viewBox, at
 * most 2048 px on the long side. Only SVGs that passed `serializeSvg` (and so
 * its node and size bounds) come here.
 */
export function rasterise(svg: string, theme: WidgetTheme): Promise<Buffer> {
  if (Buffer.byteLength(svg) > SVG_LIMITS.bytes) return Promise.reject(new Error('widget SVG over the size bound'));
  if (useInstances(svg) > SVG_LIMITS.uses) return Promise.reject(new Error('widget SVG references expand to too many instances'));
  // Each render runs in a child process (off the API's workers) and is killed
  // after RENDER_LIMITS.ms. Each distinct drawing renders once (concurrent and
  // repeat requests share the result, a refusal included) and at most
  // RENDER_LIMITS.atOnce children run across the process.
  const key = createHash('sha256').update(theme).update('\0').update(svg).digest('hex');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const png = renderSlot(() => render(svg, theme));
  cache.set(key, png);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  png.catch((e) => {
    if (!(e instanceof TooCostlyToDraw) && cache.get(key) === png) cache.delete(key);
  });
  return png;
}

const CACHE_ENTRIES = 64;
const cache = new Map<string, Promise<Buffer>>();

/** How long one render may run, and how many run at once. */
export const RENDER_LIMITS = { ms: 10_000, atOnce: 2 };

/** A drawing that didn't finish within RENDER_LIMITS.ms. */
export class TooCostlyToDraw extends Error {
  constructor() {
    super(`widget SVG took more than ${RENDER_LIMITS.ms / 1000} s to draw`);
  }
}

let rendering = 0;
const waiting: (() => void)[] = [];

async function renderSlot<T>(run: () => Promise<T>): Promise<T> {
  if (rendering < RENDER_LIMITS.atOnce) rendering++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight on
    else rendering--;
  }
}

// Dev and tests run this file from src/widgets/; production runs the bundle in
// dist/, where build.mjs copies the script to dist/widgets/.
const HERE = dirname(fileURLToPath(import.meta.url));
let childScript: string | null = null;
function rasterChild(): string {
  childScript ??= [join(HERE, 'raster-child.mjs'), join(HERE, 'widgets', 'raster-child.mjs')].find((p) => existsSync(p)) ?? null;
  if (!childScript) throw new Error(`widget raster script not found beside ${HERE}`);
  return childScript;
}

function render(svg: string, theme: WidgetTheme): Promise<Buffer> {
  const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)![1]!.trim().split(/[\s,]+/).map(Number) as number[];
  const long = Math.max(width!, height!);
  const fitTo = width! >= height!
    ? { mode: 'width' as const, value: Math.round(Math.min(width!, (MAX_RASTER_PX * width!) / long)) }
    : { mode: 'height' as const, value: Math.round(Math.min(height!, (MAX_RASTER_PX * height!) / long)) };
  const options = {
    fitTo,
    background: WIDGET_TOKENS[theme].surface,
    font: { loadSystemFonts: false, fontFiles: widgetFontFiles(), defaultFontFamily: WIDGET_FONT, sansSerifFamily: WIDGET_FONT },
  };
  return new Promise((resolve, reject) => {
    // The slot is held until the child has exited, so atOnce bounds processes.
    const child = spawn(process.execPath, [rasterChild()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RENDER_LIMITS.ms);
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString();
    });
    child.stdin.on('error', () => {}); // EPIPE from a child that died first: 'close' reports it
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new TooCostlyToDraw());
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`widget raster failed (${signal ?? code}): ${err.trim()}`));
    });
    child.stdin.end(JSON.stringify({ svg, options }));
  });
}
