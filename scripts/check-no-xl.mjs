#!/usr/bin/env node
// BlockNote's `@blocknote/xl-*` packages are GPL; Primer is MIT/Apache and
// takes only MIT, Apache-2.0 or MPL-2.0 code. This fails when any xl package
// is installed (a lockfile package or snapshot), depended on (an importer's or
// snapshot's dependencies), declared in a package.json, or imported in source.
//
// Optional peer declarations are fine: `@blocknote/math-block` and
// `diagram-block` list xl exporters as optional peers, and pnpm records those
// declarations in the lockfile without installing anything.
//
// Usage: node scripts/check-no-xl.mjs [path/to/pnpm-lock.yaml]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = process.argv[2] ? resolve(process.argv[2]) : join(root, 'pnpm-lock.yaml');
const XL = '@blocknote/xl-';
const DEPENDENCY_SECTIONS = new Set(['dependencies:', 'devDependencies:', 'optionalDependencies:']);
const problems = [];

// Lockfile: keys at indent 2 are installed packages and snapshots; keys at
// indent 6 are entries of the indent-4 section above them.
let section = '';
readFileSync(lockfile, 'utf8')
  .split('\n')
  .forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (indent === 4) section = line.trim();
    if (!line.includes(XL)) return;
    if (indent === 2 || (indent === 6 && DEPENDENCY_SECTIONS.has(section))) {
      problems.push(`${lockfile}:${i + 1}: ${line.trim()}`);
    }
  });

// package.json dependency declarations and source imports.
const workspaces = ['apps', 'packages', 'plugins'].flatMap((dir) =>
  existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((name) => join(root, dir, name)) : [],
);
for (const pkgDir of [root, ...workspaces]) {
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith(XL)) problems.push(`${pkgPath}: ${field} ${name}`);
    }
  }
  if (pkgDir !== root) scanSources(join(pkgDir, 'src'));
}

function scanSources(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') scanSources(path);
    } else if (/\.(m?[jt]sx?|cjs)$/.test(entry.name) && readFileSync(path, 'utf8').includes(XL)) {
      problems.push(`${path}: imports or names ${XL}*`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-no-xl: GPL @blocknote/xl-* packages are not allowed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('check-no-xl: no @blocknote/xl-* packages');
