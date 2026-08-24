#!/usr/bin/env node
// Mirrors this package's package.json version into its .claude-plugin/plugin.json —
// the only version field Claude Code clients read when deciding whether a cached
// plugin is stale, so a changesets bump that stops at package.json ships to nobody.
//
// This script is deliberately per-package and CWD-pure: it has no directory
// discovery of its own. `pnpm run sync:plugin-versions` fans it out via
// `pnpm -r exec`, which runs it once per workspace package with that package as
// the working directory — pnpm's workspace graph is the single source of truth
// for what counts as a plugin package. Packages without a plugin manifest are
// skipped, so non-plugin workspace packages can exist without special-casing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = '.claude-plugin/plugin.json';
if (!existsSync(MANIFEST)) process.exit(0);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

if (typeof pkg.version !== 'string') {
  console.error(`${pkg.name}: package.json has no "version"`);
  process.exit(1);
}

if (manifest.version !== pkg.version) {
  // Match prettier's JSON shape so a sync never shows up as a formatting diff.
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);
  console.log(`${pkg.name}: plugin.json ${manifest.version} -> ${pkg.version}`);
}
