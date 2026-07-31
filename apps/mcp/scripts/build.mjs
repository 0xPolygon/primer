#!/usr/bin/env node
// Build apps/mcp → dist/index.js using esbuild.
//
// esbuild is a devDependency (build-time only); production runs `node dist/index.js`
// so the runtime contains no TS executor or TS source. Same reasoning as apps/api.
//
// Strategy: bundle @primer/shared (workspace package whose package.json points
// at .ts source) and resolve .ts extensions, but keep all node_modules deps
// external so they load from the installed node_modules at runtime.
//
// Output gets a `#!/usr/bin/env node` shebang and is chmod 755 so the
// `bin: { primer-mcp: dist/index.js }` entry in package.json works without an
// extra setup step.

import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { readFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(here, '..');

// Read mcp/package.json so we know which deps to keep external.
const pkg = JSON.parse(await readFile(resolve(mcpRoot, 'package.json'), 'utf-8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  // Sub-paths of declared deps also count as external. Node will resolve them.
];
// @primer/shared is a workspace package whose entry points are .ts files —
// it must be bundled, not external.
const externalFiltered = external.filter((d) => d !== '@primer/shared');

const outfile = resolve(mcpRoot, 'dist/index.js');

await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  // Target the lowest node we support so the published bundle runs for users
  // on older runtimes. node20 has fetch/FormData/native ESM — everything the
  // MCP needs. Bump only if you start using node24-only features.
  target: 'node20',
  external: externalFiltered,
  // node:fs etc. are auto-external on platform: 'node'.
  sourcemap: true,
  logLevel: 'info',
  entryPoints: [resolve(mcpRoot, 'src/index.ts')],
  outfile,
  banner: { js: '#!/usr/bin/env node' },
});

// Make the bin entry executable.
await chmod(outfile, 0o755);

// ── Library entries (./client, ./token-store) ──────────────────────────────
//
// JS: same esbuild pass as the bin, one file per entry. Neither entry has a
// runtime dependency on @primer/shared (client's response types live in
// src/apiTypes.ts, type-only), so bundling here only inlines the package's
// own modules.
//
// Declarations: plain `tsc --emitDeclarationOnly` via tsconfig.dts.json — no
// bundler. apiTypes.ts keeps the public surface self-contained, so per-file
// .d.ts output resolves entirely within dist/.
await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: externalFiltered,
  sourcemap: true,
  logLevel: 'info',
  entryPoints: [
    resolve(mcpRoot, 'src/client.ts'),
    resolve(mcpRoot, 'src/tokenStore.ts'),
  ],
  outdir: resolve(mcpRoot, 'dist'),
});

const tscBin = resolve(mcpRoot, 'node_modules/.bin/tsc');
await execFileAsync(tscBin, ['-p', resolve(mcpRoot, 'tsconfig.dts.json')], {
  cwd: mcpRoot,
});

// tsc's rewriteRelativeImportExtensions rewrites specifiers in emitted JS
// only — declaration output preserves the source's `./apiTypes.ts` form,
// which consumers' resolvers reject. Rewrite relative .ts specifiers to .js
// in the emitted declarations; every referenced file ships in dist/, so the
// result is self-contained.
const { readdir, writeFile } = await import('node:fs/promises');
const distDir = resolve(mcpRoot, 'dist');
for (const name of await readdir(distDir)) {
  if (!name.endsWith('.d.ts')) continue;
  const p = resolve(distDir, name);
  const src = await readFile(p, 'utf-8');
  const rewritten = src.replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
  if (rewritten !== src) await writeFile(p, rewritten);
}

console.log('mcp build complete: dist/index.js + library entries (client, tokenStore)');
