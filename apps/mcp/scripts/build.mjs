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
import { readFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  target: 'node24',
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

console.log('mcp build complete: dist/index.js');
