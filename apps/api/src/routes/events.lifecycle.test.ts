// Primer's own lifecycle events (namespace `primer`), the caller-scoped
// stream, resume that cannot skip a row under concurrent commits, and the
// working status with its expiry.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql as rawSql } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { threadPlacements, users } from '../db/schema.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { setDocumentStatus } from '../lib/events.ts';
import type { DocumentStatusResponse, EventRowDTO, EventsListResponse } from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

type App = ReturnType<typeof createApp>;
const OWNER = 'mock-user-1';
const READER = 'mock-user-2'; // an org reader, not a collaborator
const ANCHOR = { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' };

async function withApp<T>(fn: (app: App, storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-lifecycle-'));
  try {
    const storage = new FilesystemStorage(root);
    const app = createApp({
      storage,
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: OWNER, email: 'one@example.com', displayName: 'User One', kind: 'person' as const, viaUserId: null },
        { id: READER, email: 'two@example.com', displayName: 'User Two', kind: 'person' as const, viaUserId: null },
      ])
      .onConflictDoNothing();
    return await fn(app, storage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function primerRows(app: App, documentId: string, userId: string): Promise<EventRowDTO[]> {
  const res = await app.request(`/api/documents/${documentId}/events?namespace=primer`, { headers: asUser(userId) });
  expect(res.status).toBe(200);
  return ((await res.json()) as EventsListResponse).events;
}

async function newThread(app: App, versionId: string, userId: string): Promise<{ id: string; commentId: string }> {
  const res = await app.request(`/api/versions/${versionId}/threads`, {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ anchor: ANCHOR, body: 'a comment' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; commentId: string };
}

/** Reads SSE frames from a response for up to `ms`, or until `max` frames. */
async function readFrames(res: Response, ms: number, max = Infinity): Promise<number[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const ids: number[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  try {
    while (ids.length < max) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
      ]);
      if (next === 'timeout' || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let sep = buffer.indexOf('\n\n'); sep !== -1; sep = buffer.indexOf('\n\n')) {
        const idLine = buffer.slice(0, sep).split('\n').find((l) => l.startsWith('id:'));
        buffer = buffer.slice(sep + 2);
        if (idLine) ids.push(Number(idLine.slice(3).trim()));
        if (ids.length >= max) break;
      }
    }
  } finally {
    await reader.cancel();
  }
  return ids;
}

describe('lifecycle events', () => {
  it('comment, reply, resolve and publish each write a primer row every reader can see', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await uploadFixture(app);
      const thread = await newThread(app, versionId, OWNER);
      const reply = await app.request(`/api/threads/${thread.id}/comments`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ body: 'a reply' }),
      });
      expect(reply.status).toBe(201);
      const replyId = ((await reply.json()) as { comment: { id: string } }).comment.id;
      expect(
        (await app.request(`/api/threads/${thread.id}/resolve`, { method: 'POST', headers: asUser(OWNER) })).status,
      ).toBe(200);

      // An org reader who is no collaborator still sees them: the page relies on it.
      const rows = await primerRows(app, documentId, READER);
      expect(rows.map((r) => r.type)).toEqual(['version.published', 'comment.created', 'comment.created', 'thread.resolved']);
      expect(rows.every((r) => r.audience === 'readers' && r.authorId === OWNER)).toBe(true);
      expect(rows[0].payload).toEqual({ document_id: documentId, version_id: versionId, number: 1, author_id: OWNER });
      expect(rows[2].payload).toEqual({
        document_id: documentId,
        version_id: versionId,
        thread_id: thread.id,
        comment_id: replyId,
        author_id: OWNER,
      });
      expect(rows[3].payload).toEqual({ document_id: documentId, thread_id: thread.id, by: OWNER });
    });
  });

  it('no client can write the primer namespace (REST and MCP share the validation)', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadFixture(app);
      for (const namespace of ['primer', 'primer/comment']) {
        const res = await app.request(`/api/documents/${documentId}/events`, {
          method: 'POST',
          headers: asUserJson(OWNER),
          body: JSON.stringify({ events: [{ namespace, type: 'status', payload: {}, audience: 'collaborators' }] }),
        });
        expect(res.status).toBe(400);
      }
      expect((await primerRows(app, documentId, OWNER)).map((r) => r.type)).toEqual(['version.published']);
    });
  });
});

describe('lifecycle events with threads across versions', () => {
  const owner = { id: OWNER, email: 'one@example.com', displayName: 'User One', kind: 'person' as const, viaUserId: null };

  it('MCP reply and resolve write the same rows as the REST routes', async () => {
    await withApp(async (app, storage) => {
      const mcp = buildMcpToolHandlers({ storage, notifier: new NoopNotifier(), apiBaseUrl: 'https://primer.example.com' });
      const { documentId, versionId } = await uploadFixture(app);
      const thread = await newThread(app, versionId, OWNER);
      const reply = await mcp.primer_reply_to_thread({ thread_id: thread.id, body: 'from an agent' }, owner);
      expect(reply.isError).toBeFalsy();
      const resolved = await mcp.primer_resolve_thread({ thread_id: thread.id }, owner);
      expect(resolved.isError).toBeFalsy();

      const rows = await primerRows(app, documentId, READER);
      expect(rows.map((r) => r.type)).toEqual(['version.published', 'comment.created', 'comment.created', 'thread.resolved']);
      expect(rows[2].payload).toMatchObject({ thread_id: thread.id, author_id: OWNER });
      expect(rows[3].payload).toEqual({ document_id: documentId, thread_id: thread.id, by: OWNER });
    });
  });

  it('a publish over REST or MCP carries open threads and writes its version row in the same commit', async () => {
    await withApp(async (app, storage) => {
      const mcp = buildMcpToolHandlers({ storage, notifier: new NoopNotifier(), apiBaseUrl: 'https://primer.example.com' });
      const { documentId, versionId } = await uploadFixture(app);
      const thread = await newThread(app, versionId, OWNER);

      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>fixture</h1><p>more</p></body></html>'], { type: 'text/html' }), 'v2.html');
      const v2 = await app.request(`/api/documents/${documentId}/versions`, { method: 'POST', headers: asUser(OWNER), body: fd });
      expect(v2.status).toBe(201);
      const v2Id = ((await v2.json()) as { versionId: string }).versionId;
      const v3 = await mcp.primer_add_version(
        { documentId, content: '<html><body><h1>fixture</h1><p>even more</p></body></html>', format: 'html' },
        owner,
      );
      expect(v3.isError).toBeFalsy();
      const v3Id = (JSON.parse(v3.content[0].text) as { versionId: string }).versionId;

      const placements = await db.select().from(threadPlacements).where(eq(threadPlacements.threadId, thread.id));
      const byVersion = new Map(placements.map((p) => [p.versionId, p.anchor]));
      expect([...byVersion.keys()].sort()).toEqual([versionId, v2Id, v3Id].sort());
      expect(byVersion.get(v2Id)).toMatchObject({ type: 'text-range', selectorText: 't' });
      expect(byVersion.get(v3Id)).toMatchObject({ type: 'text-range', selectorText: 't' });

      const rows = await primerRows(app, documentId, READER);
      expect(rows.map((r) => [r.type, r.versionId])).toEqual([
        ['version.published', versionId],
        ['comment.created', versionId],
        ['version.published', v2Id],
        ['version.published', v3Id],
      ]);
    });
  });
});

describe('GET /api/documents/:id/events/stream?since=0', () => {
  it('replays rows committed before the stream opened; without since it starts live', async () => {
    await withApp(async (app) => {
      // The web client opens with since=0 after an empty or failed hydrate,
      // so a row committed in between is still delivered.
      const { documentId } = await uploadFixture(app);
      const [published] = await primerRows(app, documentId, OWNER);
      const live = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(OWNER) });
      expect(await readFrames(live, 300)).toEqual([]);
      const fromZero = await app.request(`/api/documents/${documentId}/events/stream?since=0`, { headers: asUser(OWNER) });
      expect(await readFrames(fromZero, 300)).toEqual([published.id]);
    });
  });
});

describe('GET /api/events/stream?scope=me', () => {
  it('requires scope=me and carries only rows on documents the caller owns', async () => {
    await withApp(async (app) => {
      expect((await app.request('/api/events/stream', { headers: asUser(OWNER) })).status).toBe(400);
      const mine = await uploadFixture(app);
      const res = await app.request('/api/events/stream?scope=me&since=0', { headers: asUser(READER) });
      expect(res.status).toBe(200);
      // READER owns nothing, so the full replay is empty even though OWNER's doc has rows.
      expect(await readFrames(res, 300)).toEqual([]);
      const ownerRes = await app.request('/api/events/stream?scope=me&since=0', { headers: asUser(OWNER) });
      const ids = await readFrames(ownerRes, 300);
      expect(ids).toHaveLength(1);
      expect((await primerRows(app, mine.documentId, OWNER))[0].id).toBe(ids[0]);
    });
  });

  it('resuming from the last id seen loses nothing while writers commit out of draw order', async () => {
    await withApp(async (app) => {
      const docs = [await uploadFixture(app), await uploadFixture(app)];
      // Every event insert now sleeps a random few ms AFTER drawing its id and
      // before its transaction commits: without commit-ordered ids, a later
      // id regularly becomes visible first and a resume would skip the
      // earlier one.
      await db.execute(rawSql`
        CREATE OR REPLACE FUNCTION test_slow_event_commit() RETURNS trigger AS $$
        BEGIN PERFORM pg_sleep(random() * 0.02); RETURN NULL; END $$ LANGUAGE plpgsql`);
      await db.execute(rawSql`
        CREATE TRIGGER test_slow_event_commit AFTER INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION test_slow_event_commit()`);
      try {
        const writes = Array.from({ length: 40 }, (_, i) => {
          const doc = docs[i % 2];
          if (i % 4 === 0) return newThread(app, doc.versionId, OWNER);
          if (i % 4 === 1) return setDocumentStatus(doc.documentId, OWNER, 'working');
          return app.request(`/api/documents/${doc.documentId}/events`, {
            method: 'POST',
            headers: asUserJson(OWNER),
            body: JSON.stringify({ events: [{ namespace: 'example', type: 'tick', payload: { i }, audience: 'author' }] }),
          });
        });
        let done = false;
        const allWrites = Promise.all(writes).then(() => {
          done = true;
        });

        // Reconnect over and over, each time resuming from the last id seen
        // (what EventSource does with Last-Event-ID).
        const received: number[] = [];
        let last = 0;
        const connect = async (ms: number, max?: number) => {
          const res = await app.request('/api/events/stream?scope=me', {
            headers: { ...asUser(OWNER), 'Last-Event-ID': String(last) },
          });
          const ids = await readFrames(res, ms, max);
          // Within one connection ids only ever go up.
          expect(ids).toEqual([...ids].sort((a, b) => a - b));
          received.push(...ids);
          if (ids.length > 0) last = ids[ids.length - 1];
        };
        while (!done) await connect(60, 3);
        await allWrites;
        await connect(400);

        const expected = (await db.execute(rawSql`SELECT id FROM events ORDER BY id`)) as unknown as { id: string }[];
        expect(received).toEqual(expected.map((r) => Number(r.id)));
      } finally {
        await db.execute(rawSql`DROP TRIGGER IF EXISTS test_slow_event_commit ON events`);
        await db.execute(rawSql`DROP FUNCTION IF EXISTS test_slow_event_commit()`);
      }
    });
  }, 30_000);
});

describe('working status', () => {
  it('shows a fresh working status by name, drops it after the TTL, and clears it on idle', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadFixture(app);
      const status = async () =>
        ((await (await app.request(`/api/documents/${documentId}/status`, { headers: asUser(READER) })).json()) as DocumentStatusResponse)
          .statuses;

      // Set eleven minutes ago: past the ten-minute TTL.
      await setDocumentStatus(documentId, OWNER, 'working', new Date(Date.now() - 11 * 60 * 1000));
      expect(await status()).toEqual([]);

      const set = await app.request(`/api/documents/${documentId}/status`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ state: 'working' }),
      });
      expect(set.status).toBe(200);
      const [fresh] = await status();
      expect(fresh).toMatchObject({ by: OWNER, displayName: expect.any(String), state: 'working' });
      expect(Date.parse(fresh.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);

      // A reader who can't write events can't set a status.
      const denied = await app.request(`/api/documents/${documentId}/status`, {
        method: 'POST',
        headers: asUserJson(READER),
        body: JSON.stringify({ state: 'working' }),
      });
      expect(denied.status).toBe(403);

      await app.request(`/api/documents/${documentId}/status`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ state: 'idle' }),
      });
      expect(await status()).toEqual([]);
    });
  });
});
