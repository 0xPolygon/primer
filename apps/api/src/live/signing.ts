import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Storage } from '../storage/types.ts';
import { logger } from '../logger.ts';

/**
 * The server's key for import provenance. Export re-emits a source slice or
 * the front matter verbatim only when the server signed it at import: the
 * `sources` and `meta` maps live in the Y.Doc, which every editor can write,
 * so an unsigned entry could carry text the editor never shows.
 *
 * The key is random, made once and kept in Primer's storage (no new config).
 * Until `ensureSigningKey` has run in this process an in-memory key is used,
 * which only makes older signatures fail, and a failed signature only means
 * the blocks are serialised instead of re-emitted.
 */
const KEY_PATH = 'keys/live-import-hmac';
let key: Buffer | null = null;
let loading: Promise<void> | null = null;

export function ensureSigningKey(storage: Storage): Promise<void> {
  if (key) return Promise.resolve();
  loading ??= (async () => {
    let stored: Buffer;
    try {
      stored = Buffer.from(await new Response(await storage.get(KEY_PATH)).arrayBuffer());
    } catch (err) {
      // Only a missing key is made: any other failure (storage briefly down)
      // must not replace the key every existing signature depends on.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      stored = randomBytes(32);
      await storage.put(KEY_PATH, stored);
    }
    if (stored.length < 32) throw new Error(`live: the signing key at ${KEY_PATH} is too short`);
    key = stored;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

// Used only until the stored key is loaded; never replaces it.
let processKey: Buffer | null = null;

function currentKey(): Buffer {
  if (key) return key;
  if (!processKey) {
    logger.warn('live: import signing key not loaded; using a process-local key');
    processKey = randomBytes(32);
  }
  return processKey;
}

/** MAC over a document id and the given fields, in order. */
export function sign(documentId: string, fields: unknown[]): string {
  return createHmac('sha256', currentKey()).update(JSON.stringify([documentId, ...fields])).digest('hex');
}

export function verify(documentId: string, fields: unknown[], mac: unknown): boolean {
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(sign(documentId, fields), 'hex'), Buffer.from(mac, 'hex'));
}
