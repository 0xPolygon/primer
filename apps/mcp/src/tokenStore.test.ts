import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearToken,
  defaultStorePath,
  loadToken,
  normalizeBaseUrl,
  resolveToken,
  saveToken,
} from './tokenStore.ts';

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash from the path', () => {
    expect(normalizeBaseUrl('https://primer.up.railway.app/')).toBe('https://primer.up.railway.app');
  });

  it('lowercases the host but preserves pathname case', () => {
    expect(normalizeBaseUrl('https://Primer.UP.Railway.App/SubPath')).toBe(
      'https://primer.up.railway.app/SubPath',
    );
  });

  it('keeps an explicit port', () => {
    expect(normalizeBaseUrl('http://LOCALHOST:3000')).toBe('http://localhost:3000');
  });

  it('returns the same URL when already normalized', () => {
    expect(normalizeBaseUrl('https://primer.up.railway.app')).toBe('https://primer.up.railway.app');
  });

  it('throws for invalid URLs', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow();
    expect(() => normalizeBaseUrl('')).toThrow();
  });
});

describe('defaultStorePath', () => {
  it('honors PRIMER_TOKEN_FILE when set', () => {
    expect(defaultStorePath({ PRIMER_TOKEN_FILE: '/tmp/custom/tokens.json' })).toBe(
      '/tmp/custom/tokens.json',
    );
  });

  it('falls back to ~/.config/primer/tokens.json', () => {
    expect(defaultStorePath({})).toBe(path.join(os.homedir(), '.config', 'primer', 'tokens.json'));
  });
});

describe('token store file IO', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'primer-token-store-'));
    storePath = path.join(tmpDir, 'nested', 'tokens.json');
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves an entry keyed by normalized base URL', async () => {
    await saveToken(
      {
        baseUrl: 'https://primer.up.railway.app/',
        tokenId: 't1',
        token: 'primer_pat_abc',
        prefix: 'aaaaaaaa',
      },
      { path: storePath },
    );

    const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
    expect(Object.keys(raw)).toEqual(['https://primer.up.railway.app']);
    expect(raw['https://primer.up.railway.app']).toMatchObject({
      tokenId: 't1',
      token: 'primer_pat_abc',
      prefix: 'aaaaaaaa',
    });
    expect(typeof raw['https://primer.up.railway.app'].savedAt).toBe('string');
  });

  it('does not clobber an entry for a different base URL', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'tok1', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    await saveToken(
      { baseUrl: 'http://localhost:3000', tokenId: 't2', token: 'tok2', prefix: 'p2aaaaaa' },
      { path: storePath },
    );

    const prod = await loadToken('https://primer.up.railway.app', { path: storePath });
    const local = await loadToken('http://localhost:3000', { path: storePath });

    expect(prod?.token).toBe('tok1');
    expect(prod?.tokenId).toBe('t1');
    expect(local?.token).toBe('tok2');
    expect(local?.tokenId).toBe('t2');
  });

  it('looks up using the normalized base URL on load', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'tok1', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    // Trailing slash + different host case should still match.
    const entry = await loadToken('https://PRIMER.up.railway.app/', { path: storePath });
    expect(entry?.token).toBe('tok1');
  });

  it('clearToken removes only the requested key', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'tok1', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    await saveToken(
      { baseUrl: 'http://localhost:3000', tokenId: 't2', token: 'tok2', prefix: 'p2aaaaaa' },
      { path: storePath },
    );

    await clearToken('https://primer.up.railway.app', { path: storePath });

    expect(await loadToken('https://primer.up.railway.app', { path: storePath })).toBeNull();
    const local = await loadToken('http://localhost:3000', { path: storePath });
    expect(local?.token).toBe('tok2');

    // File still exists with the remaining entry (clearToken does not unlink).
    const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
    expect(Object.keys(raw)).toEqual(['http://localhost:3000']);
  });

  it('clearToken on a missing file is a no-op', async () => {
    await expect(
      clearToken('https://primer.up.railway.app', { path: storePath }),
    ).resolves.toBeUndefined();
  });

  it('writes the file with mode 0600', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'tok1', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    const stat = await fsp.stat(storePath);
    // Compare only the permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('creates parent directories with mkdir -p', async () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'tokens.json');
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'tok1', prefix: 'p1aaaaaa' },
      { path: deep },
    );
    const stat = await fsp.stat(deep);
    expect(stat.isFile()).toBe(true);
  });

  it('uses an atomic temp+rename: a rename failure leaves the original intact', async () => {
    // Pre-populate
    const before = JSON.stringify(
      {
        'https://existing.example': {
          tokenId: 'e1',
          token: 'primer_pat_e1',
          prefix: 'eeeeeee1',
          savedAt: '2024-01-01T00:00:00.000Z',
        },
      },
      null,
      2,
    );
    await fsp.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(storePath, before, { mode: 0o600 });

    // Force the atomic rename to fail by occupying its destination with a
    // non-empty directory. `rename(tmpPath, storePath)` on POSIX cannot
    // replace a non-empty directory with a file → ENOTDIR / ENOTEMPTY.
    // To set this up we move the existing file aside, replace it with a
    // non-empty dir, run the save (which must throw), then restore.
    const sidecar = storePath + '.sidecar';
    await fsp.rename(storePath, sidecar);
    await fsp.mkdir(storePath, { recursive: true });
    await fsp.writeFile(path.join(storePath, 'occupant'), 'x');

    await expect(
      saveToken(
        {
          baseUrl: 'https://new.example',
          tokenId: 'n1',
          token: 'primer_pat_n1',
          prefix: 'nnnnnnn1',
        },
        { path: storePath },
      ),
    ).rejects.toThrow();

    // Clean up the directory we used as the rename blocker, then restore
    // the original file content.
    await fsp.rm(storePath, { recursive: true, force: true });
    await fsp.rename(sidecar, storePath);

    const after = await fsp.readFile(storePath, 'utf-8');
    expect(after).toBe(before);

    // The temp file should be cleaned up.
    await expect(fsp.stat(storePath + '.tmp')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loadToken returns null when the file is absent', async () => {
    const entry = await loadToken('https://primer.up.railway.app', { path: storePath });
    expect(entry).toBeNull();
  });

  it('loadToken returns null on malformed JSON without logging', async () => {
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, '{not json', { mode: 0o600 });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const entry = await loadToken('https://primer.up.railway.app', { path: storePath });
    expect(entry).toBeNull();

    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('loadToken returns null when the file exists but the key is missing', async () => {
    await saveToken(
      { baseUrl: 'http://localhost:3000', tokenId: 't2', token: 'tok2', prefix: 'p2aaaaaa' },
      { path: storePath },
    );
    const entry = await loadToken('https://primer.up.railway.app', { path: storePath });
    expect(entry).toBeNull();
  });
});

describe('resolveToken precedence', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'primer-token-store-'));
    storePath = path.join(tmpDir, 'tokens.json');
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns PRIMER_API_TOKEN when set, overriding any stored entry', async () => {
    // Pre-populate a different token in the store; confirm env wins.
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'store_tok', prefix: 'p1aaaaaa' },
      { path: storePath },
    );

    const token = await resolveToken({
      env: { PRIMER_API_TOKEN: 'env_tok' },
      baseUrl: 'https://primer.up.railway.app',
      path: storePath,
    });
    expect(token).toBe('env_tok');
  });

  it('env override is returned even when the store path is unreadable', async () => {
    // If PRIMER_API_TOKEN is set, resolveToken must not depend on the store
    // being present/readable at all. We point at a path under a directory
    // that does not exist; a store-consulting implementation would either
    // throw or (per loadToken's silent-error contract) return null. Either
    // way, env wins → env_tok.
    const token = await resolveToken({
      env: { PRIMER_API_TOKEN: 'env_tok' },
      baseUrl: 'https://primer.up.railway.app',
      path: path.join(tmpDir, 'definitely', 'missing', 'tokens.json'),
    });
    expect(token).toBe('env_tok');
  });

  it('falls back to the store entry when env is unset', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'store_tok', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    const token = await resolveToken({
      env: {},
      baseUrl: 'https://primer.up.railway.app',
      path: storePath,
    });
    expect(token).toBe('store_tok');
  });

  it('returns undefined when env is unset and the store has no entry', async () => {
    const token = await resolveToken({
      env: {},
      baseUrl: 'https://primer.up.railway.app',
      path: storePath,
    });
    expect(token).toBeUndefined();
  });

  it('treats an empty PRIMER_API_TOKEN as unset', async () => {
    await saveToken(
      { baseUrl: 'https://primer.up.railway.app', tokenId: 't1', token: 'store_tok', prefix: 'p1aaaaaa' },
      { path: storePath },
    );
    const token = await resolveToken({
      env: { PRIMER_API_TOKEN: '' },
      baseUrl: 'https://primer.up.railway.app',
      path: storePath,
    });
    expect(token).toBe('store_tok');
  });
});
