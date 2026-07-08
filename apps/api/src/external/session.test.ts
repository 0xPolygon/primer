import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import {
  documents, externalShares, externalRecipients, externalViewerSessions,
} from '@primer/shared/schema';
import { generateShareToken } from './tokens.ts';
import {
  createViewerSession, lookupViewerSession,
  deleteSessionsForRecipient, deleteSessionsForShare,
  VIEWER_SESSION_TTL_MS,
} from './session.ts';

interface Chain { docId: string; shareId: string; shareToken: string; recipientId: string }

async function createChain(): Promise<Chain> {
  const docId = uuidv7();
  await db.insert(documents).values({ id: docId, title: 'Deck', uploaderId: 'mock-user-1' });
  const shareId = uuidv7();
  const shareToken = generateShareToken();
  await db.insert(externalShares).values({ id: shareId, documentId: docId, shareToken, createdBy: 'mock-user-1' });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return { docId, shareId, shareToken, recipientId };
}

describe('external viewer sessions', () => {
  it('VIEWER_SESSION_TTL_MS is pinned to 30 days', () => {
    expect(VIEWER_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('creates and looks up a session through the full join chain', async () => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, 'vitest');
    const ctx = await lookupViewerSession(s.id, ch.shareToken);
    expect(ctx).not.toBeNull();
    expect(ctx!.recipient.email).toBe('client@example.com');
    expect(ctx!.share.documentId).toBe(ch.docId);
    expect(ctx!.share.publishedVersionId).toBeNull();
    expect(ctx!.document.title).toBe('Deck');
  });

  it('rejects a session presented against a different share token', async () => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, null);
    expect(await lookupViewerSession(s.id, generateShareToken())).toBeNull();
  });

  it.each([
    ['expired session', async (ch: Chain, sid: string) =>
      db.update(externalViewerSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(externalViewerSessions.id, sid))],
    ['revoked recipient', async (ch: Chain) =>
      db.update(externalRecipients).set({ revokedAt: new Date() }).where(eq(externalRecipients.id, ch.recipientId))],
    ['expired recipient', async (ch: Chain) =>
      db.update(externalRecipients).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(externalRecipients.id, ch.recipientId))],
    ['revoked share', async (ch: Chain) =>
      db.update(externalShares).set({ revokedAt: new Date() }).where(eq(externalShares.id, ch.shareId))],
    ['soft-deleted document', async (ch: Chain) =>
      db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, ch.docId))],
  ])('lookup dies on %s', async (_label, kill) => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, null);
    await kill(ch, s.id);
    expect(await lookupViewerSession(s.id, ch.shareToken)).toBeNull();
  });

  it('deleteSessionsForRecipient / ForShare remove sessions', async () => {
    const ch = await createChain();
    const s1 = await createViewerSession(ch.recipientId, null);
    await deleteSessionsForRecipient(ch.recipientId);
    expect(await lookupViewerSession(s1.id, ch.shareToken)).toBeNull();
    const s2 = await createViewerSession(ch.recipientId, null);
    await deleteSessionsForShare(ch.shareId);
    expect(await lookupViewerSession(s2.id, ch.shareToken)).toBeNull();
  });
});
