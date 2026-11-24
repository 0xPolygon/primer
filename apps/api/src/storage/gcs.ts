import type { Storage } from './types.ts';

// Google Cloud Storage backend for production on GKE. Talks to the GCS JSON API
// over fetch rather than pulling in @google-cloud/storage, and authenticates
// with access tokens from the GKE metadata server (Workload Identity), so the
// pod holds no long-lived credentials and the API gains no new dependencies.
//
// Object names are the storage keys verbatim (`v1/<uuid>.html`), so a straight
// copy of a FilesystemStorage root into the bucket is a valid migration.

const DEFAULT_API_BASE_URL = 'https://storage.googleapis.com';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
// Refresh this long before the metadata server's stated expiry.
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// A storage call that has not finished by now is treated as failed.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GcsStorageConfig {
  bucket: string;
  apiBaseUrl?: string;
  /** Returns an OAuth access token. Defaults to the GKE metadata server. */
  getAccessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  /** Per-request timeout, covering the response body. Default 30 s. */
  timeoutMs?: number;
}

export class GcsStorage implements Storage {
  private readonly bucket: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getAccessToken: () => Promise<string>;

  constructor(config: GcsStorageConfig) {
    this.bucket = config.bucket;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.fetch = config.fetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getAccessToken = config.getAccessToken ?? makeMetadataTokenProvider(this.fetch, this.timeoutMs);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const name = encodeURIComponent(validateKey(key));
    const url = `${this.apiBaseUrl}/upload/storage/v1/b/${this.bucketPath()}/o?uploadType=media&name=${name}`;
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      // Copy into an ArrayBuffer-backed view: fetch's BodyInit rejects views
      // over a possibly-shared buffer. Documents are small, so this is cheap.
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw await gcsError('put', key, res);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    const name = encodeURIComponent(validateKey(key));
    // ifGenerationMatch=0: GCS accepts the write only if no object exists.
    const url = `${this.apiBaseUrl}/upload/storage/v1/b/${this.bucketPath()}/o?uploadType=media&ifGenerationMatch=0&name=${name}`;
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    if (res.status === 412) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok) throw await gcsError('put', key, res);
    return true;
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request(`${this.objectUrl(key)}?alt=media`, { method: 'GET' });
    if (res.status === 404) {
      await res.body?.cancel();
      throw notFound(key);
    }
    if (!res.ok || !res.body) throw await gcsError('get', key, res);
    return res.body;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request(this.objectUrl(key), { method: 'DELETE' });
    if (res.status === 404) return;
    if (!res.ok) throw await gcsError('delete', key, res);
  }

  private objectUrl(key: string): string {
    return `${this.apiBaseUrl}/storage/v1/b/${this.bucketPath()}/o/${encodeURIComponent(validateKey(key))}`;
  }

  private bucketPath(): string {
    return encodeURIComponent(this.bucket);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return this.fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }
}

// Same rule as FilesystemStorage, so a key that is valid in one backend is valid
// in the other.
function validateKey(key: string): string {
  if (key.startsWith('/') || key.includes('..')) {
    throw new Error(`invalid storage key: ${key}`);
  }
  return key;
}

// Mirrors the ENOENT that FilesystemStorage.get raises for a missing file.
function notFound(key: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`storage object not found: ${key}`);
  err.code = 'ENOENT';
  return err;
}

async function gcsError(op: string, key: string, res: Response): Promise<Error> {
  // GCS error bodies are JSON with a message; never includes the token.
  const detail = (await res.text().catch(() => '')).slice(0, 500);
  return new Error(`gcs ${op} failed for ${key}: ${res.status} ${detail}`);
}

export function makeMetadataTokenProvider(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  return async () => {
    if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) return cached.token;
    // Collapse concurrent refreshes into one metadata-server call.
    inflight ??= (async () => {
      try {
        const res = await fetchImpl(METADATA_TOKEN_URL, {
          headers: { 'metadata-flavor': 'Google' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
        const body = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!body.access_token || typeof body.expires_in !== 'number') {
          throw new Error('metadata token response missing access_token/expires_in');
        }
        cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        return cached.token;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}
