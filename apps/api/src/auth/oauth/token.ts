import type { Context, Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthRefreshTokens,
} from '@primer/shared/schema';
import { getClient } from './clients.ts';
import {
  generateAccessToken,
  generateRefreshToken,
  hashHex,
  verifyPkceS256,
} from './tokens.ts';

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function err(c: Context, error: string, description: string, status: number = 400) {
  return c.json({ error, error_description: description }, status as any);
}

async function readForm(c: Context): Promise<URLSearchParams> {
  const raw = await c.req.text();
  return new URLSearchParams(raw);
}

interface IssuedPair {
  accessToken: string;
  refreshToken: string;
  scope: string;
}

async function issueTokens(input: {
  userId: string;
  clientId: string;
  scopes: string[];
  familyId?: string;
}): Promise<IssuedPair> {
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  const familyId = input.familyId ?? uuidv7();
  const now = Date.now();
  await db.insert(oauthAccessTokens).values({
    id: uuidv7(),
    tokenHash: access.tokenHash,
    userId: input.userId,
    clientId: input.clientId,
    scopes: input.scopes,
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
  });
  await db.insert(oauthRefreshTokens).values({
    id: uuidv7(),
    familyId,
    tokenHash: refresh.tokenHash,
    userId: input.userId,
    clientId: input.clientId,
    scopes: input.scopes,
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  });
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    scope: input.scopes.join(' '),
  };
}

export function registerOAuthTokenRoute(app: Hono): void {
  app.post('/oauth/token', async (c) => {
    const body = await readForm(c);
    const grantType = body.get('grant_type') ?? '';

    if (grantType === 'authorization_code') return handleAuthCode(c, body);
    if (grantType === 'refresh_token') return handleRefresh(c, body);
    return err(c, 'unsupported_grant_type', `grant_type=${grantType}`);
  });
}

async function handleAuthCode(c: Context, body: URLSearchParams) {
  const code = body.get('code') ?? '';
  const codeVerifier = body.get('code_verifier') ?? '';
  const redirectUri = body.get('redirect_uri') ?? '';
  const clientId = body.get('client_id') ?? '';

  if (!code || !codeVerifier || !redirectUri || !clientId) {
    return err(c, 'invalid_request', 'code, code_verifier, redirect_uri, client_id required');
  }
  const client = await getClient(clientId);
  if (!client) return err(c, 'invalid_client', 'unknown client_id');

  const codeHash = hashHex(code);
  const consumed = (await db.execute(sql`
    UPDATE oauth_authorization_codes
    SET consumed_at = now()
    WHERE code_hash = ${codeHash}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND redirect_uri = ${redirectUri}
      AND client_id = ${clientId}
    RETURNING user_id AS "userId", code_challenge AS "codeChallenge",
              scopes AS "scopes"
  `)) as unknown as { userId: string; codeChallenge: string; scopes: string[] }[];

  if (consumed.length === 0) return err(c, 'invalid_grant', 'code invalid or already used');

  const row = consumed[0];
  if (!verifyPkceS256(row.codeChallenge, codeVerifier)) {
    // Consumption already happened — deliberate: burn the code on any use.
    return err(c, 'invalid_grant', 'PKCE verification failed');
  }

  const pair = await issueTokens({
    userId: row.userId,
    clientId,
    scopes: row.scopes,
  });

  return c.json({
    access_token: pair.accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: pair.refreshToken,
    scope: pair.scope,
  });
}

async function handleRefresh(c: Context, body: URLSearchParams) {
  const refreshToken = body.get('refresh_token') ?? '';
  const clientId = body.get('client_id') ?? '';
  if (!refreshToken || !clientId) return err(c, 'invalid_request', 'refresh_token, client_id required');

  const tokenHash = hashHex(refreshToken);
  const rows = (await db.execute(sql`
    SELECT id, family_id AS "familyId", user_id AS "userId", client_id AS "clientId",
           scopes, expires_at AS "expiresAt", rotated_at AS "rotatedAt",
           revoked_at AS "revokedAt"
    FROM oauth_refresh_tokens
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `)) as unknown as {
    id: string;
    familyId: string;
    userId: string;
    clientId: string;
    scopes: string[];
    expiresAt: Date;
    rotatedAt: Date | null;
    revokedAt: Date | null;
  }[];

  const row = rows[0];
  if (!row) return err(c, 'invalid_grant', 'unknown refresh_token');

  // Reuse detection: a rotated token being presented again means somebody
  // captured a used token. Nuke the whole family and return invalid_grant.
  if (row.rotatedAt !== null) {
    await db.execute(sql`
      UPDATE oauth_refresh_tokens
      SET revoked_at = now()
      WHERE family_id = ${row.familyId} AND revoked_at IS NULL
    `);
    return err(c, 'invalid_grant', 'refresh_token reuse detected');
  }

  const expiresAtTime = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt as any).getTime();
  if (row.revokedAt !== null || expiresAtTime < Date.now()) {
    return err(c, 'invalid_grant', 'refresh_token no longer valid');
  }

  if (row.clientId !== clientId) return err(c, 'invalid_client', 'client_id mismatch');

  // Mark this row rotated atomically: use a conditional UPDATE with rotated_at IS NULL
  // in the WHERE clause. If another request rotated the same token between our SELECT and
  // UPDATE, rowCount = 0 and we treat it as a race-condition reuse.
  const rotated = (await db.execute(sql`
    UPDATE oauth_refresh_tokens
    SET rotated_at = now()
    WHERE id = ${row.id} AND rotated_at IS NULL
    RETURNING id
  `)) as unknown as { id: string }[];

  if (rotated.length === 0) {
    // Race: another request rotated the same token between our SELECT and UPDATE.
    // Treat as reuse.
    await db.execute(sql`
      UPDATE oauth_refresh_tokens
      SET revoked_at = now()
      WHERE family_id = ${row.familyId} AND revoked_at IS NULL
    `);
    return err(c, 'invalid_grant', 'refresh_token reuse detected');
  }

  const pair = await issueTokens({
    userId: row.userId,
    clientId,
    scopes: row.scopes,
    familyId: row.familyId,
  });

  return c.json({
    access_token: pair.accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: pair.refreshToken,
    scope: pair.scope,
  });
}
