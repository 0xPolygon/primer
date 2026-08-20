import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, versions, externalShares, externalRecipients, externalOtps } from '../db/schema.ts';
import { issueOtp, verifyOtp, OTP_MAX_ATTEMPTS } from './otp.ts';
import { generateShareToken } from './tokens.ts';

/** Insert the doc → share → recipient chain and return the recipient id. */
async function createRecipient(): Promise<string> {
  const docId = uuidv7();
  await db.insert(documents).values({ id: docId, title: 'Deck', uploaderId: 'mock-user-1' });
  const shareId = uuidv7();
  await db.insert(externalShares).values({
    id: shareId, documentId: docId, shareToken: generateShareToken(), createdBy: 'mock-user-1',
  });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return recipientId;
}

describe('OTP lifecycle', () => {
  it('verifies a correct code once, then rejects reuse', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    expect(await verifyOtp(r, code)).toBe(true);
    expect(await verifyOtp(r, code)).toBe(false); // consumed
  });

  it('rejects a wrong code and still accepts the right one within attempts', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    expect(await verifyOtp(r, '000000')).toBe(false);
    expect(await verifyOtp(r, code)).toBe(true);
  });

  it('kills the code after OTP_MAX_ATTEMPTS wrong guesses', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOtp(r, '999999')).toBe(false);
    }
    expect(await verifyOtp(r, code)).toBe(false); // attempts exhausted
  });

  it('rejects an expired code', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    await db.update(externalOtps)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(externalOtps.recipientId, r));
    expect(await verifyOtp(r, code)).toBe(false);
  });

  it('re-issuing invalidates the prior outstanding code', async () => {
    const r = await createRecipient();
    const first = await issueOtp(r);
    const second = await issueOtp(r);
    expect(await verifyOtp(r, first.code)).toBe(false);
    expect(await verifyOtp(r, second.code)).toBe(true);
    const live = await db.select().from(externalOtps)
      .where(and(eq(externalOtps.recipientId, r), isNull(externalOtps.consumedAt)));
    expect(live.length).toBe(0);
  });
});
