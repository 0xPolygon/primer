// Dev-only mock-persona selector: cookie-based selection, the strict
// registration gate (mock mode AND not production), and the resolver's
// fallback behavior for unknown cookies.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { MOCK_USER, MOCK_USERS, MOCK_USER_COOKIE, mockResolver } from '../auth/resolver.ts';
import type { Context } from 'hono';
import type { AppVariables } from '../app.ts';

const savedAuthMode = process.env.AUTH_MODE;
const savedNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = savedAuthMode;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mockauth-'));
  try {
    // Default resolver IS mockResolver — the mode under test.
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeContext(cookieHeader: string | null): Context<{ Variables: AppVariables }> {
  return {
    req: { header: (name: string) => (name === 'cookie' ? (cookieHeader ?? undefined) : undefined) },
    set: () => {},
  } as unknown as Context<{ Variables: AppVariables }>;
}

describe('mockResolver persona cookie', () => {
  it('defaults to MOCK_USER with no cookie', async () => {
    expect(await mockResolver(fakeContext(null))).toEqual(MOCK_USER);
  });

  it('selects the persona named by primer_mock_user', async () => {
    const resolved = await mockResolver(fakeContext(`${MOCK_USER_COOKIE}=mock-user-2`));
    expect(resolved?.id).toBe('mock-user-2');
    expect(resolved?.email).toBe('mock-reviewer@polygon.technology');
  });

  it('falls back to the default on an unknown cookie value — never an authorization input', async () => {
    const resolved = await mockResolver(fakeContext(`${MOCK_USER_COOKIE}=admin`));
    expect(resolved).toEqual(MOCK_USER);
  });
});

describe('GET /auth/mock (registered only under AUTH_MODE=mock, non-production)', () => {
  it('?user= sets the persona cookie and redirects to a sanitized return_to', async () => {
    process.env.AUTH_MODE = 'mock';
    await withApp(async (app) => {
      const res = await app.request('/auth/mock?user=mock-user-2&return_to=/d/abc');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/d/abc');
      expect(res.headers.get('set-cookie')).toContain(`${MOCK_USER_COOKIE}=mock-user-2`);
      // External return_to is rejected.
      const external = await app.request('/auth/mock?user=mock-user-2&return_to=https://evil.example');
      expect(external.headers.get('location')).toBe('/');
    });
  });

  it('rejects an unknown persona with 400 and no cookie', async () => {
    process.env.AUTH_MODE = 'mock';
    await withApp(async (app) => {
      const res = await app.request('/auth/mock?user=root');
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('with no ?user= serves the picker listing every persona and marking the current one', async () => {
    process.env.AUTH_MODE = 'mock';
    await withApp(async (app) => {
      const res = await app.request('/auth/mock', {
        headers: { cookie: `${MOCK_USER_COOKIE}=mock-user-2` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const u of MOCK_USERS) expect(html).toContain(u.id);
      expect(html.indexOf('mock-user-2')).toBeGreaterThan(-1);
      expect(html).toContain('current');
    });
  });

  it('does not exist when AUTH_MODE is not mock', async () => {
    delete process.env.AUTH_MODE;
    await withApp(async (app) => {
      const res = await app.request('/auth/mock?user=mock-user-2');
      expect(res.status).toBe(404);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  it('does not exist in production even with AUTH_MODE=mock (belt and braces — boot refuses that combination anyway)', async () => {
    process.env.AUTH_MODE = 'mock';
    process.env.NODE_ENV = 'production';
    await withApp(async (app) => {
      const res = await app.request('/auth/mock?user=mock-user-2');
      expect(res.status).toBe(404);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });
});
