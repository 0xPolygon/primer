import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables } from '../app.ts';
import { db } from '../db/client.ts';
import { apiTokens, deviceAuthorizations } from '../db/schema.ts';
import { generateDeviceCode, generateToken, generateUserCode, hashToken } from '../auth/tokens.ts';

const AUTH_TTL_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 5;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface DeviceRouteOptions {
  baseUrl: string;
}

interface DeviceAuthRow {
  id: string;
  deviceCodeHash: string;
  userCode: string;
  status: string;
  userId: string | null;
  clientLabel: string | null;
  requesterIp: string | null;
  intervalSeconds: number;
  lastPolledAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Extract the requester's IP. Per spec: split x-forwarded-for on commas, trim,
 * pick the LAST non-empty entry (which represents the last hop / our proxy's
 * direct client). Falls back to the underlying socket address when the header
 * is absent — Hono on @hono/node-server exposes the raw IncomingMessage via
 * c.env.incoming.
 */
function extractRequesterIp(c: Context<{ Variables: AppVariables }>): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

async function findByDeviceHash(deviceCodeHash: string): Promise<DeviceAuthRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, device_code_hash AS "deviceCodeHash", user_code AS "userCode",
           status, user_id AS "userId", client_label AS "clientLabel",
           requester_ip AS "requesterIp", interval_seconds AS "intervalSeconds",
           last_polled_at AS "lastPolledAt", expires_at AS "expiresAt", created_at AS "createdAt"
    FROM device_authorizations
    WHERE device_code_hash = ${deviceCodeHash}
    LIMIT 1
  `)) as unknown as DeviceAuthRow[];
  return rows[0] ?? null;
}

async function findByUserCode(userCode: string): Promise<DeviceAuthRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, device_code_hash AS "deviceCodeHash", user_code AS "userCode",
           status, user_id AS "userId", client_label AS "clientLabel",
           requester_ip AS "requesterIp", interval_seconds AS "intervalSeconds",
           last_polled_at AS "lastPolledAt", expires_at AS "expiresAt", created_at AS "createdAt"
    FROM device_authorizations
    WHERE user_code = ${userCode}
    LIMIT 1
  `)) as unknown as DeviceAuthRow[];
  return rows[0] ?? null;
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export function registerDeviceRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: DeviceRouteOptions
): void {
  const baseUrl = opts.baseUrl;
  const verificationUri = baseUrl ? `${baseUrl}/device` : '/device';
  const verificationUriBase = baseUrl ? `${baseUrl}/device?code=` : '/device?code=';

  app.post('/api/device/authorize', async (c) => {
    let body: { clientLabel?: unknown } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as { clientLabel?: unknown };
    } catch {
      // Empty body is fine.
    }
    const clientLabel =
      typeof body.clientLabel === 'string' && body.clientLabel.trim().length > 0
        ? body.clientLabel.trim()
        : null;

    const { deviceCode, deviceCodeHash } = generateDeviceCode();
    const userCode = generateUserCode();
    const requesterIp = extractRequesterIp(c);
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + AUTH_TTL_SECONDS * 1000);

    await db.insert(deviceAuthorizations).values({
      id,
      deviceCodeHash,
      userCode,
      status: 'pending',
      clientLabel,
      requesterIp,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      expiresAt,
    });

    return c.json(
      {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: `${verificationUriBase}${userCode}`,
        expiresIn: AUTH_TTL_SECONDS,
        interval: DEFAULT_INTERVAL_SECONDS,
      },
      200
    );
  });

  app.get('/api/device/pending', async (c) => {
    const userCode = c.req.query('userCode');
    if (!userCode) return c.json({ error: 'missing_user_code' }, 400);

    const row = await findByUserCode(userCode);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const expiresAt = toDate(row.expiresAt)!;
    if (expiresAt.getTime() < Date.now() || row.status !== 'pending') {
      return c.json({ error: 'gone' }, 410);
    }

    return c.json(
      {
        clientLabel: row.clientLabel,
        requesterIp: row.requesterIp,
        createdAt: toDate(row.createdAt)!.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      200
    );
  });

  app.post('/api/device/token', async (c) => {
    let body: { deviceCode?: unknown } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as { deviceCode?: unknown };
    } catch {
      // ignore
    }
    const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode : '';
    if (!deviceCode) return c.json({ error: 'invalid_grant' }, 400);

    const deviceCodeHash = hashToken(deviceCode);
    const row = await findByDeviceHash(deviceCodeHash);
    if (!row) return c.json({ error: 'invalid_grant' }, 400);

    // Order of checks:
    //   expired (still-pending only) -> expired_token
    //   denied                       -> access_denied
    //   consumed                     -> invalid_grant
    //   throttle (slow_down)
    //   pending                      -> authorization_pending
    //   approved                     -> mint + transition
    const expiresAt = toDate(row.expiresAt)!;
    const expired = expiresAt.getTime() < Date.now();

    if (row.status === 'pending' && expired) {
      return c.json({ error: 'expired_token' }, 400);
    }
    if (row.status === 'denied') {
      return c.json({ error: 'access_denied' }, 400);
    }
    if (row.status === 'consumed') {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    // Throttle: respect intervalSeconds; ALWAYS update last_polled_at = now.
    const now = Date.now();
    const lastPolled = toDate(row.lastPolledAt);
    const intervalMs = row.intervalSeconds * 1000;
    const tooFast = lastPolled !== null && now - lastPolled.getTime() < intervalMs;
    // The UPDATE is conditional on a live status: a poll that read
    // status='approved' before a racing poll's mint committed must report the
    // consumption, not slow_down — slow_down would tell the client to keep
    // polling a dead grant. Drizzle's driver surfaces the affected count via
    // different keys; read whichever is present.
    const throttleUpdate = (await db.execute(sql`
      UPDATE device_authorizations
      SET last_polled_at = now()
      WHERE id = ${row.id} AND status IN ('pending', 'approved')
    `)) as unknown as { count?: number; rowCount?: number };
    let throttleAffected = 0;
    if (throttleUpdate && typeof throttleUpdate === 'object') {
      const obj = throttleUpdate as Record<string, unknown>;
      if (typeof obj.count === 'number') throttleAffected = obj.count;
      else if (typeof obj.rowCount === 'number') throttleAffected = obj.rowCount;
    }
    if (throttleAffected === 0) {
      const fresh = await db.execute(sql`
        SELECT status FROM device_authorizations WHERE id = ${row.id} LIMIT 1
      `);
      const freshStatus = ((fresh as unknown as { status: string }[])[0]?.status) ?? 'consumed';
      if (freshStatus === 'denied') return c.json({ error: 'access_denied' }, 400);
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (tooFast) return c.json({ error: 'slow_down' }, 400);

    if (row.status === 'pending') {
      return c.json({ error: 'authorization_pending' }, 400);
    }

    if (row.status === 'approved') {
      if (!row.userId) {
        // Defensive: shouldn't happen — approve sets user_id.
        return c.json({ error: 'invalid_grant' }, 400);
      }
      const minted = generateToken();
      const tokenId = uuidv7();
      const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

      // Race-safety: the outer `status === 'approved'` check happens BEFORE the
      // transaction, so two parallel polls can both pass it and both enter the
      // mint block. To prevent a double-mint, we transition the row first via
      // a conditional UPDATE (status: approved -> consumed) and only proceed
      // with the INSERT when our UPDATE actually changed a row. The loser of
      // the race sees rowCount === 0 and returns invalid_grant — same shape as
      // a stale second-poll-after-consumed, which is consistent UX.
      let raceLost = false;
      await db.transaction(async (tx) => {
        const updateResult = (await tx.execute(sql`
          UPDATE device_authorizations
          SET status = 'consumed'
          WHERE id = ${row.id} AND status = 'approved'
        `)) as unknown as { count?: number; rowCount?: number } | unknown;
        // Drizzle's underlying driver may surface rowCount via different keys.
        let affected = 0;
        if (updateResult && typeof updateResult === 'object') {
          const obj = updateResult as Record<string, unknown>;
          if (typeof obj.count === 'number') affected = obj.count;
          else if (typeof obj.rowCount === 'number') affected = obj.rowCount;
        }
        if (affected === 0) {
          raceLost = true;
          return;
        }
        await tx.insert(apiTokens).values({
          id: tokenId,
          userId: row.userId!,
          name: row.clientLabel ?? 'device login',
          tokenHash: minted.tokenHash,
          tokenPrefix: minted.tokenPrefix,
          expiresAt: tokenExpiresAt,
        });
      });

      if (raceLost) {
        return c.json({ error: 'invalid_grant' }, 400);
      }

      // CRITICAL: do NOT log the token plaintext, token hash, or response body.
      return c.json(
        {
          token: minted.token,
          tokenPrefix: minted.tokenPrefix,
          tokenId,
          expiresAt: tokenExpiresAt.toISOString(),
        },
        200
      );
    }

    // Unknown status — treat as invalid.
    return c.json({ error: 'invalid_grant' }, 400);
  });

  app.post('/api/device/approve', async (c) => {
    let body: { userCode?: unknown } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as { userCode?: unknown };
    } catch {
      // ignore
    }
    const userCode = typeof body.userCode === 'string' ? body.userCode : '';
    if (!userCode) return c.json({ error: 'missing_user_code' }, 400);

    const row = await findByUserCode(userCode);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const expiresAt = toDate(row.expiresAt)!;
    if (row.status === 'pending' && expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'expired_token' }, 400);
    }
    if (row.status !== 'pending') {
      return c.json({ error: 'already_resolved' }, 400);
    }

    const user = c.get('user');
    await db.execute(sql`
      UPDATE device_authorizations
      SET status = 'approved', user_id = ${user.id}
      WHERE id = ${row.id}
    `);

    return c.json(
      {
        clientLabel: row.clientLabel,
        requesterIp: row.requesterIp,
        createdAt: toDate(row.createdAt)!.toISOString(),
      },
      200
    );
  });

  app.post('/api/device/deny', async (c) => {
    let body: { userCode?: unknown } = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as { userCode?: unknown };
    } catch {
      // ignore
    }
    const userCode = typeof body.userCode === 'string' ? body.userCode : '';
    if (!userCode) return c.json({ error: 'missing_user_code' }, 400);

    const row = await findByUserCode(userCode);
    if (!row) return c.json({ error: 'not_found' }, 404);

    const expiresAt = toDate(row.expiresAt)!;
    if (row.status === 'pending' && expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'expired_token' }, 400);
    }
    if (row.status !== 'pending') {
      return c.json({ error: 'already_resolved' }, 400);
    }

    await db.execute(sql`
      UPDATE device_authorizations
      SET status = 'denied'
      WHERE id = ${row.id}
    `);

    return c.json({ ok: true }, 200);
  });
}
