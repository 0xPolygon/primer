// Live sync end to end: a real Hocuspocus provider over a real WebSocket to
// the hub on an in-test HTTP server, authenticated by Primer's resolvers.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { db } from '../db/client.ts';
import { apiTokens, documentCollaborators, users } from '../db/schema.ts';
import { createApp } from '../app.ts';
import { makeBearerResolver, composeResolvers } from '../auth/bearer.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { generateToken } from '../auth/tokens.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { asUser } from '../test/harness.ts';
import { createHub, CLOSE_FORBIDDEN, CLOSE_SAVE_FAILED, type Hub } from './hub.ts';
import { loadYDoc } from './persist.ts';
import { createLiveDoc } from './live.testlib.ts';

const APP_ORIGIN = 'http://app.test';
const OWNER = 'mock-user-1';
const OTHER = 'collab-user';

let server: Server;
let hub: Hub;
let url: string;
const open: HocuspocusProvider[] = [];

beforeAll(async () => {
  hub = createHub({ resolver: composeResolvers(makeBearerResolver(), mockMultiResolver), appOrigin: APP_ORIGIN });
  server = createServer();
  server.on('upgrade', hub.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
});

afterEach(() => {
  for (const provider of open.splice(0)) provider.destroy();
});

afterAll(async () => {
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asPerson = (userId: string, origin = APP_ORIGIN) => ({ 'x-mock-user-id': userId, origin });

type Client = { provider: HocuspocusProvider; doc: Y.Doc; outcome: 'synced' | 'denied'; closed: Promise<number> };

/** Opens a provider with these upgrade headers; resolves once it synced or was denied. */
async function connect(documentId: string, headers: Record<string, string>): Promise<Client> {
  class HeaderWebSocket extends WebSocket {
    constructor(target: string | URL) {
      super(target, { headers } as never);
    }
  }
  const doc = new Y.Doc();
  let onClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => (onClosed = resolve));
  const provider = new HocuspocusProvider({
    url,
    name: `doc:${documentId}`,
    document: doc,
    WebSocketPolyfill: HeaderWebSocket,
    maxAttempts: 1,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  open.push(provider);
  provider.on('close', ({ event }: { event: { code: number } }) => onClosed(event.code));
  const outcome = await new Promise<'synced' | 'denied'>((resolve) => {
    provider.on('synced', () => resolve('synced'));
    provider.on('authenticationFailed', () => resolve('denied'));
  });
  return { provider, doc, outcome, closed };
}

/** Rows stored for this document by `actorId`. */
async function storedBy(documentId: string, actorId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM doc_updates WHERE document_id = ${documentId} AND actor_id = ${actorId}
  `)) as unknown as { n: number }[];
  return row!.n;
}

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

/** Whether the upgrade is accepted, using a bare WebSocket. */
function upgradeAccepted(headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers } as never);
    socket.onopen = () => {
      socket.close();
      resolve(true);
    };
    socket.onerror = () => resolve(false);
  });
}

async function addCollaborator(documentId: string, userId: string, role: 'commenter' | 'editor') {
  await db.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: userId }).onConflictDoNothing();
  await db.insert(documentCollaborators).values({ id: uuidv7(), documentId, userId, role, grantedBy: OWNER });
}

describe('live hub', () => {
  it('editor syncs and the update persists', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    const client = await connect(id, asPerson(OWNER));
    expect(client.outcome).toBe('synced');

    client.doc.getMap('meta').set('title', 'Hello');
    await until(async () => (await storedBy(id, OWNER)) > 0);

    const { doc } = await loadYDoc(id);
    expect(doc.getMap('meta').get('title')).toBe('Hello');
  });

  it('commenter connection is read-only', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    await addCollaborator(id, OTHER, 'commenter');
    const client = await connect(id, asPerson(OTHER));
    expect(client.outcome).toBe('synced');

    client.doc.getMap('meta').set('title', 'Not mine to change');
    await sleep(300);

    expect(await storedBy(id, OTHER)).toBe(0);
    expect((await loadYDoc(id)).doc.getMap('meta').get('title')).toBeUndefined();
  });

  it('rejects cookie auth from a foreign Origin', async () => {
    expect(await upgradeAccepted(asPerson(OWNER, 'https://evil.example'))).toBe(false);
    expect(await upgradeAccepted({ 'x-mock-user-id': OWNER })).toBe(false);
    expect(await upgradeAccepted(asPerson(OWNER))).toBe(true);
  });

  it('bearer connections are read-only', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({ id: uuidv7(), userId: OWNER, name: 'test', tokenHash, tokenPrefix });

    // No Origin needed: a bearer token is not a browser credential.
    const client = await connect(id, { authorization: `Bearer ${token}` });
    expect(client.outcome).toBe('synced');

    client.doc.getMap('meta').set('title', 'Through the socket');
    await sleep(300);
    expect(await storedBy(id, OWNER)).toBe(0);
  });

  it('closes connections when access is revoked', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    await addCollaborator(id, OTHER, 'editor');
    const client = await connect(id, asPerson(OTHER));
    expect(client.outcome).toBe('synced');
    client.doc.getMap('meta').set('before', 1);
    await until(async () => (await storedBy(id, OTHER)) === 1);

    const app = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-hub-'))),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
      hub,
    });
    const res = await app.request(`/api/documents/${id}/collaborators/${OTHER}`, { method: 'DELETE', headers: asUser(OWNER) });
    expect(res.status).toBeLessThan(300);

    expect(await client.closed).toBe(CLOSE_FORBIDDEN);
    client.doc.getMap('meta').set('after', 1);
    await sleep(300);
    expect(await storedBy(id, OTHER)).toBe(1);
  });

  it('save failure closes with save_failed', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    const client = await connect(id, asPerson(OWNER));
    expect(client.outcome).toBe('synced');

    await db.execute(sql`
      CREATE FUNCTION primer_test_refuse_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER primer_test_refuse_update BEFORE INSERT ON doc_updates
      FOR EACH ROW EXECUTE FUNCTION primer_test_refuse_update()
    `);
    try {
      client.doc.getMap('meta').set('title', 'Lost?');
      expect(await client.closed).toBe(CLOSE_SAVE_FAILED);
      client.provider.destroy();
    } finally {
      await db.execute(sql`DROP TRIGGER primer_test_refuse_update ON doc_updates`);
      await db.execute(sql`DROP FUNCTION primer_test_refuse_update()`);
    }
  });

  it.todo('proxy-auth headers authenticate (with #141, through makeProxyResolver)');
});
