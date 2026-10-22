import { describe, it, expect, vi } from 'vitest';
import { GcsStorage, makeMetadataTokenProvider } from './gcs.ts';
import { storageFromEnv } from './fromEnv.ts';
import { FilesystemStorage } from './filesystem.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function makeStorage(handler: (url: string, init: RequestInit) => Response) {
  const f = fakeFetch(handler);
  const storage = new GcsStorage({
    bucket: 'primer-objects',
    getAccessToken: async () => 'tok-123',
    fetch: f.fetch,
  });
  return { storage, calls: f.calls };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('GcsStorage.put', () => {
  it('uploads the bytes as a media upload named by the URL-encoded key', async () => {
    const { storage, calls } = makeStorage(() => new Response('{}', { status: 200 }));
    const bytes = new TextEncoder().encode('<html></html>');
    await storage.put('v1/abc.html', bytes);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://storage.googleapis.com/upload/storage/v1/b/primer-objects/o?uploadType=media&name=v1%2Fabc.html',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer tok-123');
    expect(calls[0].init.body).toEqual(bytes);
  });

  it('rejects on a non-2xx response', async () => {
    const { storage } = makeStorage(() => new Response('{"error":"denied"}', { status: 403 }));
    await expect(storage.put('v1/abc.html', new Uint8Array())).rejects.toThrow(/403/);
  });

  it('rejects unsafe keys without calling GCS', async () => {
    const { storage, calls } = makeStorage(() => new Response('{}'));
    await expect(storage.put('/abc.html', new Uint8Array())).rejects.toThrow(/invalid storage key/);
    await expect(storage.put('../escape.html', new Uint8Array())).rejects.toThrow(/invalid storage key/);
    expect(calls).toHaveLength(0);
  });
});

describe('GcsStorage.get', () => {
  it('streams the object contents via alt=media', async () => {
    const { storage, calls } = makeStorage(() => new Response('<h1>hi</h1>', { status: 200 }));
    const stream = await storage.get('v1/abc.html');

    expect(await readAll(stream)).toBe('<h1>hi</h1>');
    expect(calls[0].url).toBe(
      'https://storage.googleapis.com/storage/v1/b/primer-objects/o/v1%2Fabc.html?alt=media',
    );
    expect(calls[0].init.method).toBe('GET');
  });

  it('rejects with ENOENT for a missing object, like FilesystemStorage', async () => {
    const { storage } = makeStorage(() => new Response('not found', { status: 404 }));
    await expect(storage.get('v1/missing.html')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects on other errors', async () => {
    const { storage } = makeStorage(() => new Response('boom', { status: 500 }));
    await expect(storage.get('v1/abc.html')).rejects.toThrow(/500/);
  });
});

describe('GcsStorage.delete', () => {
  it('deletes the object', async () => {
    const { storage, calls } = makeStorage(() => new Response(null, { status: 204 }));
    await storage.delete('v1/abc.html');

    expect(calls[0].url).toBe('https://storage.googleapis.com/storage/v1/b/primer-objects/o/v1%2Fabc.html');
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('is a no-op for a missing object', async () => {
    const { storage } = makeStorage(() => new Response('not found', { status: 404 }));
    await expect(storage.delete('v1/missing.html')).resolves.toBeUndefined();
  });

  it('rejects on other errors', async () => {
    const { storage } = makeStorage(() => new Response('boom', { status: 503 }));
    await expect(storage.delete('v1/abc.html')).rejects.toThrow(/503/);
  });
});

describe('makeMetadataTokenProvider', () => {
  const tokenResponse = (token: string, expiresIn: number) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }));

  it('asks the metadata server with the Metadata-Flavor header and caches the token', async () => {
    const f = fakeFetch(() => tokenResponse('t1', 3600));
    const getToken = makeMetadataTokenProvider(f.fetch);

    expect(await getToken()).toBe('t1');
    expect(await getToken()).toBe('t1');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toContain('metadata.google.internal');
    expect(new Headers(f.calls[0].init.headers).get('metadata-flavor')).toBe('Google');
  });

  it('refreshes once the token is close to expiry', async () => {
    let n = 0;
    // 30s lifetime is inside the 60s refresh skew, so every call refreshes.
    const f = fakeFetch(() => tokenResponse(`t${++n}`, 30));
    const getToken = makeMetadataTokenProvider(f.fetch);

    expect(await getToken()).toBe('t1');
    expect(await getToken()).toBe('t2');
  });

  it('collapses concurrent refreshes into one request', async () => {
    const f = fakeFetch(() => tokenResponse('t1', 3600));
    const getToken = makeMetadataTokenProvider(f.fetch);

    const tokens = await Promise.all([getToken(), getToken(), getToken()]);
    expect(tokens).toEqual(['t1', 't1', 't1']);
    expect(f.calls).toHaveLength(1);
  });

  it('rejects when the metadata server fails, and retries next call', async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? new Response('', { status: 500 }) : tokenResponse('t1', 3600)));
    const getToken = makeMetadataTokenProvider(f.fetch);

    await expect(getToken()).rejects.toThrow(/500/);
    fail = false;
    expect(await getToken()).toBe('t1');
  });
});

describe('storageFromEnv', () => {
  it('defaults to the filesystem backend at ./storage', () => {
    const { storage, description } = storageFromEnv({});
    expect(storage).toBeInstanceOf(FilesystemStorage);
    expect(description).toEqual({ backend: 'filesystem', root: './storage' });
  });

  it('selects GCS when STORAGE_BACKEND=gcs', () => {
    const { storage, description } = storageFromEnv({ STORAGE_BACKEND: 'gcs', GCS_BUCKET: 'b' });
    expect(storage).toBeInstanceOf(GcsStorage);
    expect(description).toEqual({ backend: 'gcs', bucket: 'b' });
  });

  it('requires GCS_BUCKET for the GCS backend', () => {
    expect(() => storageFromEnv({ STORAGE_BACKEND: 'gcs' })).toThrow(/GCS_BUCKET/);
  });

  it('rejects an unknown backend', () => {
    expect(() => storageFromEnv({ STORAGE_BACKEND: 's3' })).toThrow(/unknown STORAGE_BACKEND/);
  });
});
