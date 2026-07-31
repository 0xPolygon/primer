import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS ?? '14') * 24 * 60 * 60 * 1000;

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionCreate {
  userId: string;
  userAgent: string | null;
}

export interface SessionCreated {
  id: string;
  expiresAt: Date;
}

export interface SessionLookup {
  user: { id: string; email: string; displayName: string };
  session: { id: string; expiresAt: Date };
}

function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(input: SessionCreate): Promise<SessionCreated> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id,
    userId: input.userId,
    expiresAt,
    userAgent: input.userAgent,
  });
  return { id, expiresAt };
}

export async function lookupSession(id: string): Promise<SessionLookup | null> {
  const [row] = (await db.execute(sql`
    SELECT
      s.id          AS s_id,
      s.expires_at  AS s_expires_at,
      u.id          AS u_id,
      u.email       AS u_email,
      u.display_name AS u_display_name
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id}
      AND s.expires_at > now()
    LIMIT 1
  `)) as unknown as Array<{
    s_id: string;
    s_expires_at: Date | string;
    u_id: string;
    u_email: string;
    u_display_name: string;
  }>;
  if (!row) return null;
  return {
    user: { id: row.u_id, email: row.u_email, displayName: row.u_display_name },
    session: {
      id: row.s_id,
      expiresAt: row.s_expires_at instanceof Date ? row.s_expires_at : new Date(row.s_expires_at),
    },
  };
}

export async function deleteSession(id: string): Promise<void> {
  await db.execute(sql`DELETE FROM sessions WHERE id = ${id}`);
}

/**
 * Slide the expiry forward when less than REFRESH_THRESHOLD_MS remains.
 * Updates last_seen_at every call.
 */
export async function refreshSessionIfStale(id: string): Promise<void> {
  await db.execute(sql`
    UPDATE sessions
    SET last_seen_at = now(),
        expires_at = CASE
          WHEN expires_at < now() + make_interval(secs => ${REFRESH_THRESHOLD_MS / 1000})
          THEN now() + make_interval(secs => ${SESSION_TTL_MS / 1000})
          ELSE expires_at
        END
    WHERE id = ${id}
  `);
}
