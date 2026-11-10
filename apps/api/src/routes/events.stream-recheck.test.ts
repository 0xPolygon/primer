// How an open event stream re-checks access: failures close the stream
// instead of escaping as unhandled rejections (which would exit the API
// process), a burst of rows costs a bounded number of access checks rather
// than one per row, and rows still arrive in publish order.
//
// The access gate is wrapped so one user's check can be made to throw (as a
// database failover would) and so checks can be counted per user. The mock
// lives in its own file because vi.mock replaces the module for every test
// in the file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, documentCollaborators, users } from '../db/schema.ts';
import type { SendEventsResponse } from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

const gateControl = vi.hoisted(() => ({
  failFor: new Set<string>(),
  calls: new Map<string, number>(),
}));

vi.mock('../lib/events.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/events.ts')>();
  return {
    ...actual,
    gateEventAccess: async (documentId: string, userId: string) => {
      gateControl.calls.set(userId, (gateControl.calls.get(userId) ?? 0) + 1);
      if (gateControl.failFor.has(userId)) throw new Error('simulated database failure');
      return actual.gateEventAccess(documentId, userId);
    },
  };
});

type App = ReturnType<typeof createApp>;

const OWNER = 'mock-user-1';
const READER = 'mock-user-2';

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-stream-recheck-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: OWNER, email: 'one@p.t', displayName: 'User One' },
        { id: READER, email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function privateDocWithReader(app: App): Promise<string> {
  const { documentId } = await uploadFixture(app);
  await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
  await db.insert(documentCollaborators).values({
    id: uuidv7(),
    documentId,
    userId: READER,
    role: 'commenter',
    grantedBy: OWNER,
    createdAt: new Date(),
  });
  return documentId;
}

async function ownerPosts(app: App, documentId: string, count: number): Promise<number[]> {
  const events = Array.from({ length: count }, (_, i) => ({
    namespace: 'example',
    type: `burst-${i}`,
    payload: { i },
    audience: 'collaborators',
  }));
  const res = await app.request(`/api/documents/${documentId}/events`, {
    method: 'POST',
    headers: asUserJson(OWNER),
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as SendEventsResponse).events.map((r) => r.id);
}

/** Minimal SSE reader: collects `id:` frames until the server ends the stream or a deadline passes. */
function readStream(res: Response) {
  const body = res.body;
  if (!body) throw new Error('SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const ids: number[] = [];
  const pull = async (timeoutMs: number, until: () => boolean): Promise<'ended' | 'timeout' | 'done'> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (until()) return 'done';
      const left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), left));
      const next = await Promise.race([reader.read(), timer]);
      if (next === 'timeout') return 'timeout';
      if (next.done) return 'ended';
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const idLine = frame.split('\n').find((l) => l.startsWith('id:'));
        if (idLine) ids.push(Number(idLine.slice(3).trim()));
      }
    }
  };
  return {
    ids,
    waitForIds: (expected: number[], timeoutMs = 4000) => pull(timeoutMs, () => expected.every((id) => ids.includes(id))),
    waitForEnd: (timeoutMs = 3000) => pull(timeoutMs, () => false),
    close: () => reader.cancel(),
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  gateControl.failFor.clear();
  gateControl.calls.clear();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

describe('event stream re-check: failures close the stream, never crash the process', () => {
  it('a failing access check on a live row closes the stream with no unhandled rejection', async () => {
    await withApp(async (app) => {
      const documentId = await privateDocWithReader(app);
      const res = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(READER) });
      expect(res.status).toBe(200);
      const stream = readStream(res);

      gateControl.failFor.add(READER);
      const [rowId] = await ownerPosts(app, documentId, 1);

      expect(await stream.waitForEnd()).toBe('ended');
      expect(stream.ids).not.toContain(rowId);
      // Give any stray rejection a turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    });
  });

  it('a failing access check on the keepalive tick closes the stream with no unhandled rejection', async () => {
    const prev = process.env.EVENTS_SSE_KEEPALIVE_MS;
    process.env.EVENTS_SSE_KEEPALIVE_MS = '50';
    try {
      await withApp(async (app) => {
        const documentId = await privateDocWithReader(app);
        const res = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(READER) });
        expect(res.status).toBe(200);
        const stream = readStream(res);

        gateControl.failFor.add(READER);
        expect(await stream.waitForEnd()).toBe('ended');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
      });
    } finally {
      if (prev === undefined) delete process.env.EVENTS_SSE_KEEPALIVE_MS;
      else process.env.EVENTS_SSE_KEEPALIVE_MS = prev;
    }
  });
});

describe('event stream re-check: bounded cost and publish order', () => {
  it('a burst of rows costs a small constant number of access checks, not one per row', async () => {
    await withApp(async (app) => {
      const documentId = await privateDocWithReader(app);
      const res = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(READER) });
      const stream = readStream(res);
      const afterConnect = gateControl.calls.get(READER) ?? 0;

      const ids = await ownerPosts(app, documentId, 20);
      expect(await stream.waitForIds(ids)).toBe('done');
      await stream.close();

      const checks = (gateControl.calls.get(READER) ?? 0) - afterConnect;
      expect(checks).toBeLessThanOrEqual(3);
    });
  });

  it('a burst arrives in publish order for a reader who keeps access', async () => {
    await withApp(async (app) => {
      const documentId = await privateDocWithReader(app);
      const res = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(READER) });
      const stream = readStream(res);

      const ids = await ownerPosts(app, documentId, 20);
      expect(await stream.waitForIds(ids)).toBe('done');
      await stream.close();

      const delivered = stream.ids.filter((id) => ids.includes(id));
      expect(delivered).toEqual(ids);
    });
  });
});

