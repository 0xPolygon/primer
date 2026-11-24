import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { oauthAccessTokens, users } from '../db/schema.ts';
import { composeResolvers } from '../auth/bearer.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { makeOAuthBearerResolver } from '../auth/oauth/bearer.ts';
import { generateAccessToken } from '../auth/oauth/tokens.ts';
import { createClient } from '../auth/oauth/clients.ts';
import { createLiveDoc, paragraph, seedBlocks } from './live.testlib.ts';

// An OAuth agent can fork a private document it can read and then owns the
// copy; owning it must still not let the agent share, delete or widen it.
describe('OAuth agent owning a fork', () => {
  it('is refused external sharing, delete, restore, and widening to org', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-fork-owner-'));
    try {
      await db.insert(users).values({ id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User' }).onConflictDoNothing();
      const parent = await createLiveDoc({ visibility: 'private' });
      await seedBlocks(parent, [paragraph('a', 'Alpha')]);
      const client = await createClient({
        clientName: 'fork-test',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        grantTypes: ['authorization_code'],
      });
      const { token, tokenHash } = generateAccessToken();
      await db.insert(oauthAccessTokens).values({
        id: uuidv7(), tokenHash, userId: 'mock-user-1', clientId: client.clientId,
        scopes: ['primer'], expiresAt: new Date(Date.now() + 3600 * 1000),
      });
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: composeResolvers(makeOAuthBearerResolver(), mockMultiResolver),
      });
      const json = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      const forked = await app.request(`/api/documents/${parent}/fork`, { method: 'POST', headers: json, body: '{}' });
      expect(forked.status).toBe(201);
      const { documentId } = (await forked.json()) as { documentId: string };

      const base = `/api/documents/${documentId}`;
      const calls: [string, string, string | undefined][] = [
        ['POST', `${base}/external-share`, '{}'],
        ['POST', `${base}/external-share/publish`, '{}'],
        ['DELETE', base, undefined],
        ['POST', `${base}/restore`, undefined],
        ['PATCH', base, JSON.stringify({ visibility: 'org' })],
      ];
      for (const [method, path, body] of calls) {
        const res = await app.request(path, { method, headers: json, body });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
