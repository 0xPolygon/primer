import { describe, expect, it, vi } from 'vitest';
import { PrimerApiError } from './client.ts';
import { pollOnce, pollUntil, startDeviceLogin } from './deviceLogin.ts';

/** Convenience: extract first call args from a vi.fn typed as fetch. */
function firstCall(mockFetch: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return mockFetch.mock.calls[0] as unknown as [string, RequestInit];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

const BASE = 'http://localhost:3000';

describe('startDeviceLogin', () => {
  it('POSTs /api/device/authorize with clientLabel and returns the full DeviceAuthorizeResponse', async () => {
    const body = {
      deviceCode: 'dev-abc',
      userCode: 'WXYZ-1234',
      verificationUri: 'http://localhost:3000/device',
      verificationUriComplete: 'http://localhost:3000/device?code=WXYZ-1234',
      expiresIn: 600,
      interval: 5,
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));

    const result = await startDeviceLogin({
      baseUrl: BASE,
      clientLabel: 'cli-on-laptop',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result).toEqual(body);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/device/authorize');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ clientLabel: 'cli-on-laptop' });
  });

  it('omits clientLabel from the body when not provided', async () => {
    const body = {
      deviceCode: 'd',
      userCode: 'U',
      verificationUri: 'x',
      verificationUriComplete: 'x',
      expiresIn: 600,
      interval: 5,
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));

    await startDeviceLogin({
      baseUrl: BASE,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const [, init] = firstCall(mockFetch);
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('strips a trailing slash from baseUrl', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse(
        {
          deviceCode: 'd',
          userCode: 'U',
          verificationUri: 'x',
          verificationUriComplete: 'x',
          expiresIn: 600,
          interval: 5,
        },
        200,
      ),
    );

    await startDeviceLogin({
      baseUrl: 'http://localhost:3000/',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const [url] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/device/authorize');
  });

  it('throws PrimerApiError(network, ...) on fetch rejection', async () => {
    const mockFetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });

    try {
      await startDeviceLogin({
        baseUrl: BASE,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('network');
    }
  });

  it('throws PrimerApiError(bad_request) on non-2xx response', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({ error: 'internal', message: 'boom' }, 500),
    );

    try {
      await startDeviceLogin({
        baseUrl: BASE,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
      expect((err as PrimerApiError).status).toBe(500);
      expect((err as PrimerApiError).message).toBe('boom');
    }
  });
});

describe('pollOnce', () => {
  it('returns approved on 200 with token body', async () => {
    const body = {
      token: 'primer_pat_abcdef',
      tokenPrefix: 'primer_pat_abcd',
      tokenId: 'tok-123',
      expiresAt: '2026-09-01T00:00:00.000Z',
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));

    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev-abc',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result).toEqual({
      status: 'approved',
      token: body.token,
      tokenPrefix: body.tokenPrefix,
      tokenId: body.tokenId,
      expiresAt: body.expiresAt,
    });

    const [url, init] = firstCall(mockFetch);
    expect(url).toBe('http://localhost:3000/api/device/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ deviceCode: 'dev-abc' });
  });

  it('handles expiresAt as null', async () => {
    const body = {
      token: 'primer_pat_x',
      tokenPrefix: 'primer_pat_x',
      tokenId: 'tok-2',
      expiresAt: null,
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));

    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result).toEqual({
      status: 'approved',
      token: body.token,
      tokenPrefix: body.tokenPrefix,
      tokenId: body.tokenId,
      expiresAt: null,
    });
  });

  it('returns pending on 400 authorization_pending', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'authorization_pending' }, 400));
    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: 'pending' });
  });

  it('returns slow_down on 400 slow_down', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'slow_down' }, 400));
    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: 'slow_down' });
  });

  it('returns denied on 400 access_denied', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'access_denied' }, 400));
    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: 'denied' });
  });

  it('returns expired on 400 expired_token', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'expired_token' }, 400));
    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: 'expired' });
  });

  it('returns expired on 400 invalid_grant (terminal)', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const result = await pollOnce({
      baseUrl: BASE,
      deviceCode: 'dev',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: 'expired' });
  });

  it('throws PrimerApiError(bad_request) on 400 with unknown error code', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'wat' }, 400));
    try {
      await pollOnce({
        baseUrl: BASE,
        deviceCode: 'dev',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
      expect((err as PrimerApiError).status).toBe(400);
    }
  });

  it('throws PrimerApiError(bad_request) on non-400/200 status', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'internal' }, 500));
    try {
      await pollOnce({
        baseUrl: BASE,
        deviceCode: 'dev',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
      expect((err as PrimerApiError).status).toBe(500);
    }
  });

  it('throws PrimerApiError(network) on fetch rejection', async () => {
    const mockFetch = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    });
    try {
      await pollOnce({
        baseUrl: BASE,
        deviceCode: 'dev',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('network');
    }
  });

  it('tolerates a non-JSON 400 body (treats as unknown error → bad_request)', async () => {
    const mockFetch = vi.fn(async () => textResponse('bad', 400));
    try {
      await pollOnce({
        baseUrl: BASE,
        deviceCode: 'dev',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
    }
  });
});

describe('pollUntil', () => {
  it('returns immediately on approved without sleeping', async () => {
    const body = {
      token: 'primer_pat_x',
      tokenPrefix: 'primer_pat_x',
      tokenId: 'tok',
      expiresAt: null,
    };
    const mockFetch = vi.fn(async () => jsonResponse(body, 200));
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result.status).toBe('approved');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(0);
  });

  it('returns immediately on denied', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'access_denied' }, 400));
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result).toEqual({ status: 'denied' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(0);
  });

  it('returns immediately on expired', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'expired_token' }, 400));
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result).toEqual({ status: 'expired' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps polling on pending and sleeps with the server interval', async () => {
    const approved = {
      token: 'primer_pat_x',
      tokenPrefix: 'primer_pat_x',
      tokenId: 'tok',
      expiresAt: null,
    };
    let call = 0;
    const mockFetch = vi.fn(async () => {
      call += 1;
      if (call < 3) return jsonResponse({ error: 'authorization_pending' }, 400);
      return jsonResponse(approved, 200);
    });
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result.status).toBe('approved');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Slept twice (after each pending), both at 5000ms.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5000);
  });

  it('doubles the interval on slow_down (capped at 60s)', async () => {
    // Sequence: slow_down (interval 10 → 20), slow_down (20 → 40),
    // slow_down (40 → 60), slow_down (60 → 60 cap), then approved.
    const approved = {
      token: 't',
      tokenPrefix: 'p',
      tokenId: 'i',
      expiresAt: null,
    };
    const responses: Array<() => Response> = [
      () => jsonResponse({ error: 'slow_down' }, 400),
      () => jsonResponse({ error: 'slow_down' }, 400),
      () => jsonResponse({ error: 'slow_down' }, 400),
      () => jsonResponse({ error: 'slow_down' }, 400),
      () => jsonResponse(approved, 200),
    ];
    let i = 0;
    const mockFetch = vi.fn(async () => responses[i++]!());
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 10,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result.status).toBe('approved');
    // Sleeps: 20000, 40000, 60000, 60000.
    expect(
      (sleep.mock.calls as unknown as Array<[number]>).map((c) => c[0]),
    ).toEqual([20000, 40000, 60000, 60000]);
  });

  it('returns { status: "pending" } on timeout (does NOT throw)', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'authorization_pending' }, 400));
    // Fake clock: every sleep advances `now` by the given ms.
    let now = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const nowFn = () => now;

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      timeoutMs: 10_000,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
      nowFn,
    });

    expect(result).toEqual({ status: 'pending' });
    // 10s window / 5s interval = 2 polls before the third would push us past.
    // The exact count isn't load-bearing — what matters is timeout returns
    // pending rather than throwing. But we do expect MULTIPLE polls happened.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries on network errors up to 3 times then surfaces', async () => {
    const mockFetch = vi.fn(async () => {
      throw new TypeError('ECONNREFUSED');
    });
    const sleep = vi.fn(async () => {});

    try {
      await pollUntil({
        baseUrl: BASE,
        deviceCode: 'dev',
        interval: 5,
        fetchImpl: mockFetch as unknown as typeof fetch,
        sleep,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('network');
    }
    // 3 retries means 4 fetch attempts total (the original + 3 retries).
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('a transient network error followed by approved succeeds', async () => {
    const approved = {
      token: 't',
      tokenPrefix: 'p',
      tokenId: 'i',
      expiresAt: null,
    };
    let call = 0;
    const mockFetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError('temporary glitch');
      return jsonResponse(approved, 200);
    });
    const sleep = vi.fn(async () => {});

    const result = await pollUntil({
      baseUrl: BASE,
      deviceCode: 'dev',
      interval: 5,
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep,
    });

    expect(result.status).toBe('approved');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('non-network PrimerApiError propagates immediately (no retry)', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ error: 'wat' }, 400));
    const sleep = vi.fn(async () => {});

    try {
      await pollUntil({
        baseUrl: BASE,
        deviceCode: 'dev',
        interval: 5,
        fetchImpl: mockFetch as unknown as typeof fetch,
        sleep,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrimerApiError);
      expect((err as PrimerApiError).code).toBe('bad_request');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
