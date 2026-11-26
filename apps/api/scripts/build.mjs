#!/usr/bin/env node
// Build apps/api → dist/ using esbuild.
//
// esbuild is a devDependency (build-time only); production runs `node dist/...`
// so the runtime contains no TS executor or TS source. This addresses the
// supply-chain audit finding around tsx being in the production runtime path.
//
// Strategy: bundle @polygonlabs/primer-api-types (workspace package whose
// package.json points at .ts source) and resolve .ts extensions, but keep all
// node_modules deps external so they load from the installed node_modules at
// runtime.

import { build } from 'esbuild';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');

// Read api/package.json so we know which deps to keep external.
const pkg = JSON.parse(await readFile(resolve(apiRoot, 'package.json'), 'utf-8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  // Sub-paths of declared deps also count as external. Node will resolve them.
];
// Workspace packages whose entry points are .ts/.tsx source
// (@polygonlabs/primer-api-types, @primer/blocks) must be bundled, not external.
const bundledWorkspace = new Set(['@polygonlabs/primer-api-types', '@primer/blocks']);
const externalFiltered = external.filter((d) => !bundledWorkspace.has(d));

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: externalFiltered,
  // node:fs etc. are auto-external on platform: 'node'.
  sourcemap: true,
  logLevel: 'info',
  // @primer/blocks renders its custom blocks with React (automatic runtime).
  jsx: 'automatic',
  // Each entry point keeps its file extension via outExtension; default is fine.
};

await build({
  ...common,
  entryPoints: [resolve(apiRoot, 'src/index.ts')],
  outfile: resolve(apiRoot, 'dist/index.js'),
});

await build({
  ...common,
  entryPoints: [resolve(apiRoot, 'src/db/migrate.ts')],
  outfile: resolve(apiRoot, 'dist/db/migrate.js'),
});

await build({
  ...common,
  entryPoints: [resolve(apiRoot, 'src/jobs/purge-cli.ts')],
  outfile: resolve(apiRoot, 'dist/jobs/purge-cli.js'),
});

// Copy static assets that the runtime reads directly from disk.
// The companion script and the vendored Mermaid bundle are served byte-for-byte
// by their respective routes — esbuild won't bundle them because nothing imports
// them as a module.
await mkdir(resolve(apiRoot, 'dist/companion'), { recursive: true });
await copyFile(
  resolve(apiRoot, 'src/companion/v1.js'),
  resolve(apiRoot, 'dist/companion/v1.js'),
);
// Read the pinned version from the TS constant so this script stays in sync
// without duplicating the literal.
const versionModule = await readFile(
  resolve(apiRoot, 'src/companion/mermaidVersion.ts'),
  'utf-8',
);
const versionMatch = versionModule.match(/MERMAID_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!versionMatch) {
  throw new Error('Could not extract MERMAID_VERSION from mermaidVersion.ts');
}
const mermaidVersion = versionMatch[1];
await copyFile(
  resolve(apiRoot, `src/companion/mermaid-v${mermaidVersion}.js`),
  resolve(apiRoot, `dist/companion/mermaid-v${mermaidVersion}.js`),
);

// The widget raster script runs as a child process of its own (raster.ts).
await mkdir(resolve(apiRoot, 'dist/widgets'), { recursive: true });
await copyFile(
  resolve(apiRoot, 'src/widgets/raster-child.mjs'),
  resolve(apiRoot, 'dist/widgets/raster-child.mjs'),
);

// The authoring and widget skills, served as the MCP resources
// primer://skills/authoring and primer://skills/widgets.
await mkdir(resolve(apiRoot, 'dist/skills'), { recursive: true });
for (const name of ['authoring.md', 'widgets.md']) {
  await copyFile(
    resolve(apiRoot, `../../plugins/primer/skills/primer/${name}`),
    resolve(apiRoot, `dist/skills/${name}`),
  );
}

console.log(
  `api build complete: dist/skills/authoring.md, dist/skills/widgets.md, dist/index.js, dist/db/migrate.js, dist/jobs/purge-cli.js, dist/widgets/raster-child.mjs, dist/companion/v1.js, dist/companion/mermaid-v${mermaidVersion}.js`,
);
