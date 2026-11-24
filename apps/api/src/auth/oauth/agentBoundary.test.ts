import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../app.ts';
import { FilesystemStorage } from '../../storage/filesystem.ts';
import { NoopNotifier } from '../../notifications/notifier.ts';
import { db } from '../../db/client.ts';
import { oauthAccessTokens, oauthClients, users } from '../../db/schema.ts';
import { composeResolvers } from '../bearer.ts';
import { mockMultiResolver } from '../resolver.ts';
import { makeOAuthBearerResolver } from './bearer.ts';
import { generateAccessToken } from './tokens.ts';
import { createClient } from './clients.ts';

// An OAuth agent carries no token scopes, so the NOT_GRANTABLE table must be
// enforced for it directly: owning a document (here via upload) must not let
// it delete, externally share or widen that document.

type App = ReturnType<typeof createApp>;

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-oauth-boundary-'));
  try {
    return await fn(
      createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: composeResolvers(makeOAuthBearerResolver(), mockMultiResolver),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function oauthToken(): Promise<string> {
  await db.insert(users).values({ id: 'oauth-owner', email: 'oauth-owner@x.test', displayName: 'o' }).onConflictDoNothing();
  const client = await createClient({
    clientName: 'boundary-test',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    grantTypes: ['authorization_code'],
  });
  const { token, tokenHash } = generateAccessToken();
  await db.insert(oauthAccessTokens).values({
    id: uuidv7(),
    tokenHash,
    userId: 'oauth-owner',
    clientId: client.clientId,
    scopes: ['primer'],
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  return token;
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthClients);
});

describe('OAuth agent owning a document', () => {
  it('is refused external sharing, delete, restore, and widening to org', async () => {
    const token = await oauthToken();
    const auth = { authorization: `Bearer ${token}` };
    const json = { ...auth, 'content-type': 'application/json' };
    await withApp(async (app) => {
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><p>hi</p></body></html>'], { type: 'text/html' }), 'a.html');
      fd.append('title', 'Agent upload');
      const up = await app.request('/api/upload', { method: 'POST', headers: auth, body: fd });
      expect(up.status).toBeLessThan(300);
      const { documentId } = (await up.json()) as { documentId: string };

      const base = `/api/documents/${documentId}`;
      const calls: [string, string, string | undefined][] = [
        ['POST', `${base}/external-share`, '{}'],
        ['GET', `${base}/external-share`, undefined],
        ['POST', `${base}/external-share/publish`, '{}'],
        ['DELETE', base, undefined],
        ['POST', `${base}/restore`, undefined],
        ['PATCH', base, JSON.stringify({ visibility: 'org' })],
      ];
      for (const [method, path, body] of calls) {
        const res = await app.request(path, { method, headers: json, body });
        expect(res.status, `${method} ${path}`).toBe(403);
      }

      // Still allowed: the agent can read and narrow its own document.
      expect((await app.request(base, { headers: auth })).status).toBe(200);
      const narrow = await app.request(base, { method: 'PATCH', headers: json, body: JSON.stringify({ visibility: 'private' }) });
      expect(narrow.status).toBe(200);
    });
  });

  it('starts private: its person can read and widen it, another member cannot read it', async () => {
    const token = await oauthToken();
    const auth = { authorization: `Bearer ${token}` };
    const person = { 'x-mock-user-id': 'oauth-owner', 'x-primer-csrf': '1', 'content-type': 'application/json' };
    const colleague = { 'x-mock-user-id': 'colleague-x' };
    await withApp(async (app) => {
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><p>hi</p></body></html>'], { type: 'text/html' }), 'a.html');
      fd.append('title', 'Agent upload');
      const up = await app.request('/api/upload', { method: 'POST', headers: auth, body: fd });
      expect(up.status).toBeLessThan(300);
      const { documentId } = (await up.json()) as { documentId: string };
      const base = `/api/documents/${documentId}`;

      const row = await app.request(base, { headers: person });
      expect(row.status).toBe(200);
      const detail = (await row.json()) as { document: { visibility: string } };
      expect(detail.document.visibility).toBe('private');
      expect((await app.request(base, { headers: colleague })).status).toBe(404);

      // The person (the owner of what their agents upload) can widen it.
      const widen = await app.request(base, { method: 'PATCH', headers: person, body: JSON.stringify({ visibility: 'org' }) });
      expect(widen.status).toBe(200);
      expect((await app.request(base, { headers: colleague })).status).toBe(200);
    });
  });
});
