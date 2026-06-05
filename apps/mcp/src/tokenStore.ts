import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TokenStoreEntry {
  tokenId: string;
  token: string;
  prefix: string;
  savedAt: string;
}

export type TokenStoreFile = Record<string, TokenStoreEntry>;

/**
 * Returns the default token store path: `$PRIMER_TOKEN_FILE` if set,
 * else `~/.config/primer/tokens.json`.
 */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PRIMER_TOKEN_FILE;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.config', 'primer', 'tokens.json');
}

/**
 * Normalizes a Primer API base URL for use as a token store key.
 * - Lowercases the host (preserving pathname case).
 * - Strips a trailing slash from the pathname.
 * - Throws on invalid URLs.
 */
export function normalizeBaseUrl(s: string): string {
  // `new URL` throws TypeError on invalid input.
  const url = new URL(s);
  const pathname = url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

async function readStoreFile(filePath: string): Promise<TokenStoreFile> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TokenStoreFile;
    }
    return {};
  } catch {
    // Missing file, malformed JSON, or unreadable — caller treats as empty.
    return {};
  }
}

/**
 * Persists a token entry under `normalizeBaseUrl(baseUrl)`.
 * Atomic via temp file + rename. File mode 0600, dir mode 0700.
 */
export async function saveToken(
  opts: { baseUrl: string; tokenId: string; token: string; prefix: string },
  options?: { path?: string },
): Promise<void> {
  const filePath = options?.path ?? defaultStorePath();
  const key = normalizeBaseUrl(opts.baseUrl);
  const dir = path.dirname(filePath);

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const current = await readStoreFile(filePath);
  current[key] = {
    tokenId: opts.tokenId,
    token: opts.token,
    prefix: opts.prefix,
    savedAt: new Date().toISOString(),
  };

  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(current, null, 2);

  try {
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(payload);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file so we don't leave debris behind.
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Returns the entry for `baseUrl` (looked up by normalized key), or null
 * if the file is missing, malformed, or has no matching entry. Never logs.
 */
export async function loadToken(
  baseUrl: string,
  options?: { path?: string },
): Promise<TokenStoreEntry | null> {
  const filePath = options?.path ?? defaultStorePath();
  let key: string;
  try {
    key = normalizeBaseUrl(baseUrl);
  } catch {
    return null;
  }
  const file = await readStoreFile(filePath);
  return file[key] ?? null;
}

/**
 * Removes the entry for `baseUrl` (if present) and rewrites the file.
 * If the file is absent, this is a no-op. The file is preserved (possibly
 * with `{}`) rather than unlinked — the file structure is the invariant.
 */
export async function clearToken(
  baseUrl: string,
  options?: { path?: string },
): Promise<void> {
  const filePath = options?.path ?? defaultStorePath();
  const key = normalizeBaseUrl(baseUrl);

  // If the file doesn't exist at all, there's nothing to clear.
  try {
    await fsp.stat(filePath);
  } catch {
    return;
  }

  const current = await readStoreFile(filePath);
  if (!(key in current)) return;
  delete current[key];

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(current, null, 2);

  try {
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(payload);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Resolves the active API token for `baseUrl`.
 * Precedence: `PRIMER_API_TOKEN` env > stored entry > undefined.
 * The env override never reads the store.
 */
export async function resolveToken(opts: {
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  path?: string;
}): Promise<string | undefined> {
  const envToken = opts.env.PRIMER_API_TOKEN;
  if (envToken && envToken.length > 0) return envToken;
  const entry = await loadToken(opts.baseUrl, { path: opts.path });
  return entry?.token;
}
