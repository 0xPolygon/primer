#!/usr/bin/env node
// Build apps/mcp → dist/index.js using esbuild.
//
// esbuild is a devDependency (build-time only); production runs `node dist/index.js`
// so the runtime contains no TS executor or TS source. Same reasoning as apps/api.
//
// Strategy: keep all node_modules deps external so they load from the
// installed node_modules at runtime, and bundle everything else (including
// devDependencies like @polygonlabs/primer-api-types). The contract package
// is a devDependency whose guards must inline into the bundle.
//
// Output gets a `#!/usr/bin/env node` shebang and is chmod 755 so the
// `bin: { primer-mcp: dist/index.js }` entry in package.json works without an
// extra setup step.

import { build } from 'esbuild';
import { readFile, chmod, mkdir, copyFile } from 'node:fs/promises';
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
// devDependencies like @polygonlabs/primer-api-types are not in dependencies,
// so they are bundled automatically. Their guards inline into the dist.
const externalFiltered = external;

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

// The authoring skill, served as the MCP resource primer://skills/authoring.
await mkdir(resolve(mcpRoot, 'dist/skills'), { recursive: true });
for (const name of ['authoring.md', 'widgets.md']) {
  await copyFile(resolve(mcpRoot, `../../plugins/primer/skills/primer/${name}`), resolve(mcpRoot, `dist/skills/${name}`));
}

console.log('mcp build complete: dist/index.js, dist/skills/authoring.md, dist/skills/widgets.md');
