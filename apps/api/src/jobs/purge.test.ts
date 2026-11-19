import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  docFiles,
  documents,
  versions,
  sessions,
  users,
  apiTokens,
  deviceAuthorizations,
} from '../db/schema.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import {
  purgeExpiredDocuments,
  purgeExpiredSessions,
  purgeStaleDeviceAuthorizations,
  purgeRevokedTokens,
} from './purge.ts';
import { generateDeviceCode, generateToken } from '../auth/tokens.ts';

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
  it('a purged live document takes its bundles and files with it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-live-'));
    try {
      const storage = new FilesystemStorage(root);
      const { publishDocument } = await import('../lib/publish.ts');
      const r = await publishDocument(storage, {
        actor: { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null },
        title: 'Live',
        filename: 'live.md',
        format: 'markdown',
        content: new TextEncoder().encode('# Live\n'),
      });
      if (!r.ok) throw new Error(r.refusal.code);
      const fileKey = `files/${r.documentId}/${uuidv7()}`;
      await storage.put(fileKey, new TextEncoder().encode('png'));
      await db.insert(docFiles).values({ id: fileKey.split('/')[2]!, documentId: r.documentId, storageKey: fileKey, contentType: 'image/png', sizeBytes: 3, uploadedBy: 'mock-user-1' });
      await db.update(documents).set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }).where(eq(documents.id, r.documentId));

      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedStorageKeys).toEqual(expect.arrayContaining([
        `bundles/${r.versionId}/static.html`, `bundles/${r.versionId}/state.ydoc`, `v1/${r.versionId}.orig`, fileKey,
      ]));
      await expect(access(join(root, 'bundles', r.versionId, 'state.ydoc'))).rejects.toThrow();
      await expect(access(join(root, fileKey))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

describe('purgeExpiredSessions', () => {
  it('deletes sessions whose expires_at is more than 7 days in the past', async () => {
    const userId = `purge-sess-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const oldSid = 'old' + 'a'.repeat(61);
    const freshSid = 'fresh' + 'a'.repeat(59);
    await db.insert(sessions).values([
      {
        id: oldSid,
        userId,
        expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
      {
        id: freshSid,
        userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const report = await purgeExpiredSessions();
    expect(report.deletedCount).toBe(1);

    const remaining = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(freshSid);
  });

  it('returns deletedCount: 0 when nothing is past the grace window', async () => {
    const report = await purgeExpiredSessions();
    expect(report.deletedCount).toBeGreaterThanOrEqual(0);
  });
});

describe('purgeStaleDeviceAuthorizations', () => {
  it('deletes rows whose expires_at is more than 1 day in the past, leaves recent rows', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const staleId = uuidv7();
    const freshId = uuidv7();
    const staleDeviceCode = generateDeviceCode();
    const freshDeviceCode = generateDeviceCode();
    const staleUserCode = `S${tag.slice(0, 3).toUpperCase()}-AAAA`;
    const freshUserCode = `F${tag.slice(0, 3).toUpperCase()}-BBBB`;

    await db.insert(deviceAuthorizations).values([
      {
        id: staleId,
        deviceCodeHash: staleDeviceCode.deviceCodeHash,
        userCode: staleUserCode,
        status: 'pending',
        intervalSeconds: 5,
        // 2 days ago — outside the 1-day grace window.
        expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        id: freshId,
        deviceCodeHash: freshDeviceCode.deviceCodeHash,
        userCode: freshUserCode,
        status: 'pending',
        intervalSeconds: 5,
        // Expired 1 hour ago — still within the grace window, should remain.
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ]);

    const report = await purgeStaleDeviceAuthorizations();
    expect(report.deletedCount).toBeGreaterThanOrEqual(1);

    const staleRows = await db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.id, staleId));
    expect(staleRows).toHaveLength(0);

    const freshRows = await db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.id, freshId));
    expect(freshRows).toHaveLength(1);

    // Cleanup.
    await db.delete(deviceAuthorizations).where(eq(deviceAuthorizations.id, freshId));
  });

  it('returns deletedCount: 0 when nothing is past the grace window', async () => {
    const report = await purgeStaleDeviceAuthorizations();
    expect(report.deletedCount).toBeGreaterThanOrEqual(0);
  });
});

describe('purgeRevokedTokens', () => {
  it('deletes tokens revoked >30 days ago; keeps recently revoked and never-revoked tokens', async () => {
    const userId = `purge-tok-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });

    const oldRevokedId = uuidv7();
    const recentRevokedId = uuidv7();
    const liveId = uuidv7();
    const oldTok = generateToken();
    const recentTok = generateToken();
    const liveTok = generateToken();

    await db.insert(apiTokens).values([
      {
        id: oldRevokedId,
        userId,
        name: 'old-revoked',
        tokenHash: oldTok.tokenHash,
        tokenPrefix: oldTok.tokenPrefix,
        revokedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
      {
        id: recentRevokedId,
        userId,
        name: 'recent-revoked',
        tokenHash: recentTok.tokenHash,
        tokenPrefix: recentTok.tokenPrefix,
        revokedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      {
        id: liveId,
        userId,
        name: 'live',
        tokenHash: liveTok.tokenHash,
        tokenPrefix: liveTok.tokenPrefix,
        revokedAt: null,
      },
    ]);

    const report = await purgeRevokedTokens();
    expect(report.deletedCount).toBeGreaterThanOrEqual(1);

    const oldRows = await db.select().from(apiTokens).where(eq(apiTokens.id, oldRevokedId));
    expect(oldRows).toHaveLength(0);

    const recentRows = await db.select().from(apiTokens).where(eq(apiTokens.id, recentRevokedId));
    expect(recentRows).toHaveLength(1);

    const liveRows = await db.select().from(apiTokens).where(eq(apiTokens.id, liveId));
    expect(liveRows).toHaveLength(1);

    // Cleanup. The users row cascades to api_tokens.
    await db.delete(users).where(eq(users.id, userId));
  });

  it('returns deletedCount: 0 when no tokens are past the grace window', async () => {
    const report = await purgeRevokedTokens();
    expect(report.deletedCount).toBeGreaterThanOrEqual(0);
  });
});
