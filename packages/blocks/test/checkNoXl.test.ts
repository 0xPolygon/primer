import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../../../scripts/check-no-xl.mjs');

function run(lockfile?: string) {
  return spawnSync(process.execPath, lockfile ? [script, lockfile] : [script], { encoding: 'utf8' });
}

describe('check-no-xl', () => {
  it('check-no-xl fails on any xl package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-no-xl-'));
    const lockfile = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      lockfile,
      ["lockfileVersion: '9.0'", '', 'packages:', '', "  '@blocknote/xl-ai@0.57.0':", '    resolution: {integrity: sha512-x}', ''].join('\n'),
    );
    const result = run(lockfile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'@blocknote/xl-ai@0.57.0'");
  });

  it('passes on the repository, where xl packages are only optional peer declarations', () => {
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
