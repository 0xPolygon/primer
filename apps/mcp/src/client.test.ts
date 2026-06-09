import { describe, expect, it, vi } from 'vitest';
import { PrimerApiError, PrimerClient } from './client.ts';

/** Convenience: pulls the first call's `[url, init]` tuple out of a vi.fn()
 *  whose typed signature (fetch) confuses TS into inferring `[]` for calls. */
function firstCall(mockFetch: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return mockFetch.mock.calls[0] as unknown as [string, RequestInit];
}

function jsonResponse(body: unknown, status = 200, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

function makeClient(
  fetchImpl: typeof fetch,
  opts: { baseUrl?: string; token?: string } = {},
): PrimerClient {
  return new PrimerClient({
    baseUrl: opts.baseUrl ?? 'http://localhost:3000',
    token: opts.token ?? 'primer_pat_test',
    fetchImpl,
  });
}

describe('PrimerClient.whoami', () => {
  it('GETs /api/me with a Bearer token and returns the UserDTO', async () => {
    const user = { id: 'u1', email: 'alice@example.com', displayName: 'Alice' };
    const mockFetch = vi.fn(async () => jsonResponse(user, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.whoami();

    expect(result).toEqual(user);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/me');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer primer_pat_test');
  });
});

describe('PrimerClient.getDocument', () => {
  it('GETs /api/documents/:id and returns the document detail', async () => {
    const body = {
      document: {
        id: 'd1',
        title: 'Hello',
        description: null,
        uploaderId: 'u1',
        uploaderDisplayName: 'Alice',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      latestVersion: {
        id: 'v1',
        versionNumber: 1,
        versionNote: null,
        sizeBytes: 42,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.getDocument('d1');

    expect(result).toEqual(body);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/documents/d1');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer primer_pat_test');
  });
});

describe('PrimerClient.listVersions', () => {
  it('GETs /api/documents/:id/versions and returns the versions list', async () => {
    const body = {
      versions: [
        { id: 'v2', versionNumber: 2, versionNote: 'fix scale', sizeBytes: 100, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'v1', versionNumber: 1, versionNote: null, sizeBytes: 99, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.listVersions('d1');

    expect(result).toEqual(body);
    const [url] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/documents/d1/versions');
  });
});

describe('PrimerClient.getVersionThreads', () => {
  it('GETs /api/versions/:versionId/threads', async () => {
    const body = { threads: [], asOf: '2026-01-03T00:00:00.000Z' };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.getVersionThreads('v1');

    expect(result).toEqual(body);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/versions/v1/threads');
    expect(init.method).toBe('GET');
  });
});

describe('PrimerClient.createDocument', () => {
  it('POSTs multipart to /api/upload with doc.md for markdown', async () => {
    const body = { documentId: 'd1', versionId: 'v1', url: '/d/d1' };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.createDocument({
      title: 'My Doc',
      description: 'Some desc',
      content: '# hello',
      format: 'markdown',
    });

    expect(result).toEqual(body);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/upload');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer primer_pat_test');
    // Critical: must NOT set Content-Type manually — fetch handles the boundary.
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();

    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    const file = fd.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('doc.md');
    expect((file as File).type).toBe('text/markdown');
    expect(await (file as File).text()).toBe('# hello');
    expect(fd.get('title')).toBe('My Doc');
    expect(fd.get('description')).toBe('Some desc');
    // No template passed → no template field on the form.
    expect(fd.get('template')).toBeNull();
  });

  it('appends the template field when provided', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ documentId: 'd3', versionId: 'v3', url: '/d/d3' }, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await client.createDocument({
      title: 'Styled',
      content: '<p>hi</p>',
      format: 'html',
      template: 'paperclip-punkify',
    });

    const [, init] = firstCall(mockFetch);
    const fd = init.body as FormData;
    expect(fd.get('template')).toBe('paperclip-punkify');
  });

  it('uses doc.html and text/html for html format and omits description when absent', async () => {
    const body = { documentId: 'd2', versionId: 'v2', url: '/d/d2' };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await client.createDocument({
      title: 'HTML Doc',
      content: '<p>hi</p>',
      format: 'html',
    });

    const [, init] = firstCall(mockFetch);
    const fd = init.body as FormData;
    const file = fd.get('file') as File;
    expect(file.name).toBe('doc.html');
    expect(file.type).toBe('text/html');
    expect(await file.text()).toBe('<p>hi</p>');
    expect(fd.get('title')).toBe('HTML Doc');
    expect(fd.get('description')).toBeNull();
  });
});

describe('PrimerClient.addVersion', () => {
  it('POSTs multipart to /api/documents/:id/versions with file and versionNote', async () => {
    const body = { versionId: 'v3', versionNumber: 3, url: '/d/d1' };
    const mockFetch = vi.fn(async () => jsonResponse(body, 201));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    const result = await client.addVersion({
      documentId: 'd1',
      content: '# v3',
      format: 'markdown',
      versionNote: 'tweaked something',
    });

    expect(result).toEqual(body);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/documents/d1/versions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer primer_pat_test');
    expect(headers['Content-Type']).toBeUndefined();

    const fd = init.body as FormData;
    const file = fd.get('file') as File;
    expect(file.name).toBe('doc.md');
    expect(file.type).toBe('text/markdown');
    expect(await file.text()).toBe('# v3');
    expect(fd.get('versionNote')).toBe('tweaked something');
    expect(fd.get('template')).toBeNull();
  });

  it('appends the template field when provided', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ versionId: 'v5', versionNumber: 5, url: '/d/d1' }, 201));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await client.addVersion({
      documentId: 'd1',
      content: '<p>v5</p>',
      format: 'html',
      template: 'paperclip-punkify',
    });

    const [, init] = firstCall(mockFetch);
    const fd = init.body as FormData;
    expect(fd.get('template')).toBe('paperclip-punkify');
  });

  it('omits versionNote when not provided and uses doc.html for html', async () => {
    const body = { versionId: 'v4', versionNumber: 4, url: '/d/d1' };
    const mockFetch = vi.fn(async () => jsonResponse(body, 201));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await client.addVersion({
      documentId: 'd1',
      content: '<p>v4</p>',
      format: 'html',
    });

    const [, init] = firstCall(mockFetch);
    const fd = init.body as FormData;
    const file = fd.get('file') as File;
    expect(file.name).toBe('doc.html');
    expect(file.type).toBe('text/html');
    expect(fd.get('versionNote')).toBeNull();
  });
});

describe('PrimerClient.revokeToken', () => {
  it('DELETEs /api/tokens/:tokenId with the bearer token', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ ok: true }, 200));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await client.revokeToken('tok_123');

    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/tokens/tok_123');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer primer_pat_test');
  });
});

describe('PrimerClient base URL normalization', () => {
  it('strips a trailing slash from the base URL', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ id: 'u1', email: 'a', displayName: 'A' }, 200));
    const client = new PrimerClient({
      baseUrl: 'http://localhost:3000/',
      token: 'primer_pat_test',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await client.whoami();

    const [url] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/me');
  });
});

describe('PrimerClient error mapping', () => {
  it('maps 401 to PrimerApiError with code not_authenticated', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    try {
      await client.whoami();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('not_authenticated');
      expect((err as PrimerApiError).status).toBe(401);
    }
  });

  it('maps 403 to forbidden', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await expect(client.getDocument('d1')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });

  it('maps 404 to not_found', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'not_found' }, 404));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await expect(client.getDocument('missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('maps 400 to bad_request and carries the server message through', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({ error: 'validation_failed', message: 'title is required' }, 400),
    );
    const client = makeClient(mockFetch as unknown as typeof fetch);

    try {
      await client.createDocument({ title: '', content: 'x', format: 'markdown' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      const e = err as PrimerApiError;
      expect(e.code).toBe('bad_request');
      expect(e.status).toBe(400);
      expect(e.message).toBe('title is required');
    }
  });

  it('maps 429 to rate_limited', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'rate_limited' }, 429));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    await expect(client.whoami()).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('maps 5xx to bad_request with status surfaced', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'internal' }, 503));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    try {
      await client.whoami();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      const e = err as PrimerApiError;
      expect(e.code).toBe('bad_request');
      expect(e.status).toBe(503);
    }
  });

  it('wraps fetch rejections (network errors) into code: network', async () => {
    const mockFetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    const client = makeClient(mockFetch as unknown as typeof fetch);

    try {
      await client.whoami();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      const e = err as PrimerApiError;
      expect(e.code).toBe('network');
      expect(e.status).toBeUndefined();
      // Should not surface as a raw TypeError.
      expect(e.name).toBe('PrimerApiError');
    }
  });

  it('tolerates a non-JSON error body (text/plain) and still maps the status', async () => {
    const mockFetch = vi.fn(async () => textResponse('Internal Server Error', 500));
    const client = makeClient(mockFetch as unknown as typeof fetch);

    try {
      await client.whoami();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
      expect((err as PrimerApiError).status).toBe(500);
    }
  });
});
