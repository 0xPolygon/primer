import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { externalOtps } from '@primer/shared/schema';
import { generateOtpCode, hashOtpCode, otpHashesEqual } from './tokens.ts';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** One live code per recipient: issuing consumes any outstanding code. */
export async function issueOtp(recipientId: string): Promise<{ code: string }> {
  const code = generateOtpCode();
  await db
    .update(externalOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(externalOtps.recipientId, recipientId), isNull(externalOtps.consumedAt)));
  await db.insert(externalOtps).values({
    id: uuidv7(),
    recipientId,
    codeHash: hashOtpCode(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return { code };
}

/**
 * Charge an attempt atomically BEFORE comparing, so concurrent guesses can
 * never exceed OTP_MAX_ATTEMPTS — the UPDATE's attempt_count guard is the
 * source of truth, not application logic.
 */
export async function verifyOtp(recipientId: string, code: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE external_otps
    SET attempt_count = attempt_count + 1
    WHERE recipient_id = ${recipientId}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND attempt_count < ${OTP_MAX_ATTEMPTS}
    RETURNING id, code_hash AS "codeHash"
  `)) as unknown as Array<{ id: string; codeHash: string }>;
  const otp = rows[0];
  if (!otp) return false;
  if (!otpHashesEqual(otp.codeHash, hashOtpCode(code))) return false;
  await db.update(externalOtps).set({ consumedAt: new Date() }).where(eq(externalOtps.id, otp.id));
  return true;
}
