import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { purgeExpiredDocuments } from './purge.ts';

async function seedExpiredDoc(daysOld: number, storage: FilesystemStorage) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Expired',
    description: null,
    uploaderId: 'mock-user-1',
    deletedAt: new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000),
  });
  const storageKey = `v1/${versionId}.html`;
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey,
    sizeBytes: 5,
    versionNote: null,
  });
  await storage.put(storageKey, new TextEncoder().encode('hello'));
  return { documentId, versionId, storageKey };
}

describe('purgeExpiredDocuments', () => {
  it('returns empty report when nothing is expired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-empty-'));
    try {
      const storage = new FilesystemStorage(root);
      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).toHaveLength(0);
      expect(report.purgedStorageKeys).toHaveLength(0);
      expect(report.failedStorageKeys).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes an expired doc and its storage file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-one-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId, storageKey } = await seedExpiredDoc(31, storage);

      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).toContain(documentId);
      expect(report.purgedStorageKeys).toContain(storageKey);
      expect(report.failedStorageKeys).toHaveLength(0);

      // DB rows gone.
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
      // Storage file gone.
      await expect(storage.get(storageKey)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not purge docs deleted within the 30-day window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-skip-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(29, storage);

      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).not.toContain(documentId);

      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records failed storage deletes but still removes the DB row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-fail-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(31, storage);

      // Wrap storage.delete to fail for any v1/ key.
      const failingStorage = {
        ...storage,
        async put(key: string, bytes: Uint8Array) { return storage.put(key, bytes); },
        async get(key: string) { return storage.get(key); },
        async delete(key: string) {
          throw new Error('boom');
        },
      };

      const report = await purgeExpiredDocuments({ storage: failingStorage as unknown as FilesystemStorage });
      expect(report.failedStorageKeys.length).toBeGreaterThan(0);

      // DB row should still be gone (DB consistency wins per the design).
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on a clean DB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-idem-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(31, storage);
      await purgeExpiredDocuments({ storage });
      const second = await purgeExpiredDocuments({ storage });
      expect(second.purgedDocumentIds).toHaveLength(0);
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
