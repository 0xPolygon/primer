// Open event streams stop as soon as the credential they were opened with is
// revoked, through the same registry that closes live-sync sockets.
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { mockMultiResolver, type UserResolver } from '../auth/resolver.ts';
import { generateToken } from '../auth/tokens.ts';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { asUser } from '../test/harness.ts';

const OWNER = 'mock-user-1';

// The persona header only when sent, so a revoked token never falls back
// to a default persona.
const resolver: UserResolver = composeResolvers(makeBearerResolver(), async (c) =>
  c.req.header('x-mock-user-id') ? mockMultiResolver(c) : null,
);

async function makeApp() {
  return createApp({
    storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-stream-revoke-'))),
    notifier: new NoopNotifier(),
    userResolver: resolver,
  });
}

/** Resolves true once the body ends (the server closed the stream). */
async function endsWithin(body: ReadableStream<Uint8Array>, ms: number): Promise<boolean> {
  const reader = body.getReader();
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      void reader.cancel();
      return false;
    }
    const next = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), left)),
    ]);
    if (next === 'timeout') {
      void reader.cancel();
      return false;
    }
    if (next.done) return true;
  }
}

describe('event streams and credential revocation', () => {
  it('revoking a token closes an open owner stream and an open per-document stream', async () => {
    const app = await makeApp();
    const form = new FormData();
    form.append('file', new Blob(['<html><body><h1>fixture</h1></body></html>'], { type: 'text/html' }), 'fixture.html');
    form.append('title', 'Fixture doc');
    const upload = await app.request('/api/upload', { method: 'POST', headers: asUser(OWNER), body: form });
    const { documentId } = (await upload.json()) as { documentId: string };
    const tokenId = uuidv7();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({ id: tokenId, userId: OWNER, name: 'test', tokenHash, tokenPrefix });
    const bearer = { authorization: `Bearer ${token}` };

    const owner = await app.request('/api/events/stream?scope=me', { headers: bearer });
    const perDoc = await app.request(`/api/documents/${documentId}/events/stream`, { headers: bearer });
    expect(owner.status).toBe(200);
    expect(perDoc.status).toBe(200);
    // Both streams are up and idle: nothing ends them on its own.
    const [ownerBody, perDocBody] = [owner.body!, perDoc.body!];

    const res = await app.request(`/api/tokens/${tokenId}`, { method: 'DELETE', headers: asUser(OWNER) });
    expect(res.status).toBe(200);

    const [ownerEnded, perDocEnded] = await Promise.all([endsWithin(ownerBody, 2000), endsWithin(perDocBody, 2000)]);
    expect(ownerEnded).toBe(true);
    expect(perDocEnded).toBe(true);
  });

  it('an open stream stays open while its token is valid', async () => {
    const app = await makeApp();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({ id: uuidv7(), userId: OWNER, name: 'test', tokenHash, tokenPrefix });
    const owner = await app.request('/api/events/stream?scope=me', { headers: { authorization: `Bearer ${token}` } });
    expect(await endsWithin(owner.body!, 300)).toBe(false);
  });
});
