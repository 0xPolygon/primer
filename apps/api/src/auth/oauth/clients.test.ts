import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import {
  REDIRECT_URI_ALLOWLIST,
  isRedirectUriAllowed,
  getClient,
  createClient,
} from './clients.ts';

beforeEach(async () => {
  await db.delete(oauthClients);
});

describe('REDIRECT_URI_ALLOWLIST', () => {
  it('contains Claude Web callback', () => {
    expect(REDIRECT_URI_ALLOWLIST).toContain('https://claude.ai/api/mcp/auth_callback');
  });
});

describe('isRedirectUriAllowed', () => {
  it('accepts exact-match allowlisted URIs', () => {
    expect(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('accepts loopback URIs on any port', () => {
    expect(isRedirectUriAllowed('http://127.0.0.1:8123/cb')).toBe(true);
    expect(isRedirectUriAllowed('http://127.0.0.1:65535/whatever')).toBe(true);
  });

  it('accepts localhost loopback URIs on any port', () => {
    expect(isRedirectUriAllowed('http://localhost:8123/cb')).toBe(true);
    expect(isRedirectUriAllowed('http://localhost:65535/whatever')).toBe(true);
  });

  it('rejects unlisted hosts', () => {
    expect(isRedirectUriAllowed('https://evil.example.com/cb')).toBe(false);
  });

  it('rejects http on non-loopback', () => {
    expect(isRedirectUriAllowed('http://claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isRedirectUriAllowed('not a url')).toBe(false);
  });
});

describe('createClient + getClient', () => {
  it('round-trips', async () => {
    const created = await createClient({
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    expect(created.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
    const fetched = await getClient(created.clientId);
    expect(fetched?.clientName).toBe('Claude');
    expect(fetched?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('returns null for unknown clientId', async () => {
    expect(await getClient('does-not-exist')).toBeNull();
  });
});
