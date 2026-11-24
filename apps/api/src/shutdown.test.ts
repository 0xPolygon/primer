import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { MOCK_USER } from './auth/resolver.ts';
import { db } from './db/client.ts';
import { docUpdates, threadPlacements, threads, versions } from './db/schema.ts';
import { liveDocName, liveInstance } from './live/instance.ts';
import { createLiveDoc, paragraph, seedBlocks } from './live/live.testlib.ts';
import { SYSTEM_ORIGIN, originFor } from './live/origin.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { drainPendingWork } from './shutdown.ts';
import { FilesystemStorage } from './storage/filesystem.ts';

// More documents than the pool's 10 connections.
const DOCS = 14;

describe('shutdown', () => {
  it('saves every pending update and automatic checkpoint, more than the pool holds, and finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-shutdown-test-'));
    try {
      createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const ids: string[] = [];
      for (let i = 0; i < DOCS; i++) {
        const id = await createLiveDoc();
        await seedBlocks(id, [paragraph(`p${i}`, `Paragraph ${i}`)]);
        // A widget-part thread: placing it on a checkpoint reads the widget table inside the transaction.
        await db.insert(threads).values({ id: uuidv7(), documentId: id, anchor: { type: 'widget-part', target: { tabId: 'main', blockId: `p${i}` }, anchor: 'bars' } });
        ids.push(id);
      }
      // An edit by a person on each, left queued for storage and with its checkpoint still settling.
      const connections = await Promise.all(ids.map((id) => liveInstance().openDirectConnection(liveDocName(id), originFor(MOCK_USER))));
      for (const connection of connections) void connection.transact((doc) => doc.getMap('pending').set('edit', 1));

      await drainPendingWork();

      const edits = await db.select({ documentId: docUpdates.documentId, touched: docUpdates.touched }).from(docUpdates).where(inArray(docUpdates.documentId, ids));
      for (const id of ids) expect(edits.some((e) => e.documentId === id && e.touched.includes('pending'))).toBe(true);
      const saved = await db.select({ id: versions.id, documentId: versions.documentId, automatic: versions.automatic }).from(versions).where(inArray(versions.documentId, ids));
      expect(saved).toHaveLength(DOCS);
      expect(saved.every((v) => v.automatic)).toBe(true);
      const placed = await db.select().from(threadPlacements).where(inArray(threadPlacements.versionId, saved.map((v) => v.id)));
      expect(placed).toHaveLength(DOCS);
      await Promise.all(connections.map((c) => c.disconnect({ unloadImmediately: false })));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('saves live updates still queued for storage', async () => {
    // System writes schedule no checkpoint or sync: only the drain stores them.
    const ids = await Promise.all(Array.from({ length: DOCS }, () => createLiveDoc()));
    const connections = await Promise.all(ids.map((id) => liveInstance().openDirectConnection(liveDocName(id), SYSTEM_ORIGIN)));
    for (const connection of connections) for (let n = 0; n < 5; n++) void connection.transact((doc) => doc.getMap('pending').set('edit', n));

    await drainPendingWork();

    const stored = await db.select({ documentId: docUpdates.documentId }).from(docUpdates).where(inArray(docUpdates.documentId, ids));
    expect(stored).toHaveLength(DOCS * 5);
    await Promise.all(connections.map((c) => c.disconnect({ unloadImmediately: false })));
  });
});
