import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { CreateTokenResponse, LibraryResponse, MeResponse, ThreadDTO } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { makeOAuthBearerResolver } from '../auth/oauth/bearer.ts';
import { createClient } from '../auth/oauth/clients.ts';
import { generateAccessToken } from '../auth/oauth/tokens.ts';
import { mockResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { apiTokens, oauthAccessTokens, users } from '../db/schema.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { generateToken } from '../auth/tokens.ts';
import { ensureOAuthAgent } from '../auth/oauth/bearer.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

type App = ReturnType<typeof createApp>;

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-agents-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      // Bearers first; anything else is mock-user-1 ("Mock User").
      userResolver: composeResolvers(makeOAuthBearerResolver(), makeBearerResolver(), mockResolver),
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const json = { ...CSRF_HEADERS, 'content-type': 'application/json' };
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** mock-user-1 creates an agent and mints it a token with every scope it needs here. */
async function agentToken(app: App): Promise<{ agentId: string; token: string }> {
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ displayName: 'Claude' }),
  });
  expect(created.status).toBe(201);
  const { id: agentId } = (await created.json()) as { id: string };
  const minted = await app.request(`/api/agents/${agentId}/tokens`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      name: 'test',
      scopes: ['documents:read', 'documents:write', 'comments:write', 'collaborators:manage'],
    }),
  });
  expect(minted.status).toBe(201);
  return { agentId, token: ((await minted.json()) as CreateTokenResponse).token };
}

function htmlForm(): FormData {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>v</p></body></html>'], { type: 'text/html' }), 'v.html');
  fd.append('title', 'Agent doc');
  return fd;
}

beforeEach(async () => {
  await db.insert(users).values({ id: 'agents-other', email: 'other@x.test', displayName: 'Other' }).onConflictDoNothing();
});

describe('agents', () => {
  it('minted agent token authenticates as the agent with via', async () => {
    await withApp(async (app) => {
      const { agentId, token } = await agentToken(app);
      const me = (await (await app.request('/api/me', { headers: bearer(token) })).json()) as MeResponse;
      expect(me).toMatchObject({ id: agentId, kind: 'agent', viaUserId: 'mock-user-1', displayName: 'Claude (via Mock User)' });

      const list = await app.request('/api/agents', { headers: json });
      expect(((await list.json()) as { agents: { id: string }[] }).agents.map((a) => a.id)).toEqual([agentId]);
    });
  });

  it("agent inherits its person's access capped at editor", async () => {
    await withApp(async (app) => {
      const doc = await uploadFixture(app);
      const { token } = await agentToken(app);

      const add = await app.request(`/api/documents/${doc.documentId}/versions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: htmlForm(),
      });
      expect(add.status).toBe(201);

      const visibility = await app.request(`/api/documents/${doc.documentId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(visibility.status).toBe(403);
      const del = await app.request(`/api/documents/${doc.documentId}`, { method: 'DELETE', headers: bearer(token) });
      expect(del.status).toBe(403);
    });
  });

  it('oauth token acts as a per-client agent', async () => {
    const client = await createClient({
      clientName: 'Claude Desktop',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'mock-user-1',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    await withApp(async (app) => {
      const me = (await (await app.request('/api/me', { headers: bearer(token) })).json()) as MeResponse;
      expect(me.id).toMatch(/^agent_oauth_[0-9a-f]{24}$/);
      expect(me).toMatchObject({ displayName: 'Claude Desktop (via Mock User)', kind: 'agent', viaUserId: 'mock-user-1' });
    });
  });

  it('a person owns what their agent created', async () => {
    await withApp(async (app) => {
      const { token } = await agentToken(app);
      const up = await app.request('/api/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: htmlForm(),
      });
      expect(up.status).toBe(200);
      const { documentId } = (await up.json()) as { documentId: string };

      const library = (await (await app.request('/api/library')).json()) as LibraryResponse;
      expect(library.documents.find((d) => d.id === documentId)?.ownership).toBe('mine');

      const share = await app.request(`/api/documents/${documentId}/collaborators`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ userId: 'agents-other', role: 'editor' }),
      });
      expect(share.status).toBe(201);
      const del = await app.request(`/api/documents/${documentId}`, { method: 'DELETE', headers: json });
      expect(del.status).toBe(200);
    });
  });

  it('comments carry the agent label', async () => {
    await withApp(async (app) => {
      const doc = await uploadFixture(app);
      const { token } = await agentToken(app);
      const res = await app.request(`/api/versions/${doc.versionId}/threads`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'f', prefix: '', suffix: '', containerPath: 'body' },
          body: 'From an agent.',
        }),
      });
      expect(res.status).toBe(201);
      const thread = (await res.json()) as ThreadDTO;
      expect(thread.comments[0]).toMatchObject({ authorKind: 'agent', authorVia: 'Mock User' });
    });
  });

  it('a client named like an existing person still renders as an agent', async () => {
    const client = await createClient({
      clientName: 'Mock User',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'mock-user-1',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    await withApp(async (app) => {
      const doc = await uploadFixture(app);
      const res = await app.request(`/api/versions/${doc.versionId}/threads`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'f', prefix: '', suffix: '', containerPath: 'body' },
          body: 'Looks good to me.',
        }),
      });
      expect(res.status).toBe(201);
      const author = ((await res.json()) as ThreadDTO).comments[0];
      expect(author.authorDisplayName).toBe('Mock User (via Mock User)');
      expect(author.authorKind).toBe('agent');
      const me = (await (await app.request('/api/me', { headers: bearer(token) })).json()) as MeResponse;
      expect(me.displayName).not.toBe('Mock User');
    });
  });

  it('agent names drop control and bidi characters and are capped', async () => {
    const agent = await ensureOAuthAgent('client-x', `\u202eMock\u0000 User\u200f ${'x'.repeat(100)}`, 'mock-user-1');
    const [row] = await db.select().from(users).where(sql`${users.id} = ${agent.id}`);
    expect(row.displayName).toMatch(/^Mock User x+$/);
    expect(row.displayName.length).toBeLessThanOrEqual(64);
  });

  it('the migration revokes service-claude tokens no one could manage any more', async () => {
    await db.insert(users).values({ id: 'service-claude', email: 'claude-service@polygon.technology', displayName: 'Claude' }).onConflictDoNothing();
    const minted = generateToken();
    await db.insert(apiTokens).values({
      id: uuidv7(),
      userId: 'service-claude',
      name: 'legacy',
      tokenHash: minted.tokenHash,
      tokenPrefix: minted.tokenPrefix,
      scopes: ['documents:read'],
    });
    // Re-run the migration's data steps, as they run on a database that has
    // live service tokens.
    const migration = await readFile(fileURLToPath(new URL('../../drizzle/0017_agent_identities.sql', import.meta.url)), 'utf8');
    for (const stmt of migration.split('--> statement-breakpoint')) {
      const body = stmt.replace(/^\s*--.*$/gm, '').trim();
      if (body.startsWith('UPDATE')) await db.execute(sql.raw(body));
    }
    await withApp(async (app) => {
      const res = await app.request('/api/me', { headers: bearer(minted.token) });
      // The bearer no longer resolves; the mock fallback answers as mock-user-1.
      expect(((await res.json()) as MeResponse).id).toBe('mock-user-1');
    });
    const [svc] = await db.select().from(users).where(sql`${users.id} = 'service-claude'`);
    expect(svc.kind).toBe('agent');
  });
});
