import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from './app.ts';
import { MOCK_USER } from './auth/resolver.ts';
import { db } from './db/client.ts';
import { docUpdates, threadPlacements, threads, versions } from './db/schema.ts';
import { liveDocName, liveInstance } from './live/instance.ts';
import { createLiveDoc, paragraph, seedBlocks } from './live/live.testlib.ts';
import { SYSTEM_ORIGIN, originFor } from './live/origin.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { track } from './inflight.ts';
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

  it('a terminated server writes every settling checkpoint, more than the pool holds, and exits', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'primer-shutdown-test-'));
    const port = 33000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), AUTH_MODE: 'mock', STORAGE_BACKEND: 'filesystem', STORAGE_ROOT: storageRoot, PURGE_INTERVAL_MS: '3600000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Also when the test times out (a server stuck in shutdown).
    onTestFinished(() => void (child.exitCode === null && child.kill('SIGKILL')));
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      for (let i = 0; i < 200 && !out.includes('primer api listening'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain('primer api listening');
      const call = (path: string, init?: RequestInit) => fetch(`http://localhost:${port}${path}`, { ...init, headers: { 'x-primer-csrf': '1', ...init?.headers } });

      const ids: string[] = [];
      for (let i = 0; i < DOCS; i++) {
        const form = new FormData();
        form.set('file', new File([`Paragraph ${i}.\n`], 'doc.md', { type: 'text/markdown' }));
        form.set('title', `Doc ${i}`);
        const { documentId } = (await (await call('/api/upload', { method: 'POST', body: form })).json()) as { documentId: string };
        const live = (await (await call(`/api/documents/${documentId}/live?format=json`)).json()) as { blocks: { target: { tabId: string; blockId: string }; version: string }[] };
        const [block] = live.blocks;
        await db.insert(threads).values({ id: uuidv7(), documentId, anchor: { type: 'widget-part', target: block!.target, anchor: 'bars' } });
        // A person's edit: its automatic checkpoint settles minutes later.
        const edited = await call(`/api/documents/${documentId}/ops`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseVersion: 0, ops: [{ op: 'update', target: block!.target, block: `Paragraph ${i}, edited.`, expectVersion: block!.version }] }),
        });
        expect(edited.status).toBe(200);
        ids.push(documentId);
      }

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      for (const id of ids) {
        const saved = await db.select({ automatic: versions.automatic }).from(versions).where(eq(versions.documentId, id));
        expect(saved.filter((v) => v.automatic)).toHaveLength(1);
      }
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('awaits a slow notification send, and is not held past its bound by one that never settles', async () => {
    let sent = false;
    void track(new Promise<void>((resolve) => setTimeout(() => { sent = true; resolve(); }, 150)));
    await drainPendingWork(5_000);
    expect(sent).toBe(true);

    void track(new Promise<void>(() => {}));
    const started = Date.now();
    await drainPendingWork(200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
