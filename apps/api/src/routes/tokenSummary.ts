import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { recheckAccess } from '../auth/revocation.ts';
import { apiTokens } from '../db/schema.ts';
import { generateToken } from '../auth/tokens.ts';
import type { ApiTokenScope, ApiTokenSummary, CreateTokenResponse } from '@polygonlabs/primer-api-types';
import { parseRequestedScopes, parseStoredScopes } from '../auth/scopes.ts';

export const MAX_ACTIVE_TOKENS_PER_USER = 25;
export const MAX_TOKEN_NAME_LENGTH = 100;

export interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[] | null;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoNullable(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * Converts a DB row to a public ApiTokenSummary. NEVER include `token_hash`
 * or any other secret material here.
 */
export function toSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: parseStoredScopes(row.scopes),
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIsoNullable(row.lastUsedAt),
    expiresAt: toIsoNullable(row.expiresAt),
    revokedAt: toIsoNullable(row.revokedAt),
  };
}

export async function listTokensForUser(userId: string): Promise<ApiTokenSummary[]> {
  const rows = (await db.execute(sql`
    SELECT id,
           name,
           token_prefix AS "tokenPrefix",
           scopes,
           created_at AS "createdAt",
           last_used_at AS "lastUsedAt",
           expires_at AS "expiresAt",
           revoked_at AS "revokedAt"
    FROM api_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `)) as unknown as TokenRow[];
  return rows.map(toSummary);
}

/** Trims and validates a token name from an untrusted request body. */
export function parseTokenName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_TOKEN_NAME_LENGTH) return null;
  return name;
}

/**
 * Validates a create-token request body ({ name, scopes? }). Returns the
 * error code to answer 400 with, or the parsed values.
 */
export function parseCreateTokenBody(
  raw: unknown,
): { ok: true; name: string; scopes: ApiTokenScope[] | null } | { ok: false; error: 'invalid_name' | 'invalid_scopes' } {
  const body = (raw ?? null) as { name?: unknown; scopes?: unknown } | null;
  const name = parseTokenName(body?.name);
  if (name === null) return { ok: false, error: 'invalid_name' };
  const scopes = parseRequestedScopes(body?.scopes);
  if (!scopes.ok) return { ok: false, error: 'invalid_scopes' };
  return { ok: true, name, scopes: scopes.scopes };
}

/**
 * Mints a never-expiring API token for `userId`, limited to `scopes`
 * (null = unrestricted). Returns 'token_limit' when
 * the user is at the active-token cap. The plaintext token in the result is
 * shown to the caller exactly once and never stored.
 */
export async function mintTokenForUser(
  userId: string,
  name: string,
  scopes: ApiTokenScope[] | null,
): Promise<CreateTokenResponse | 'token_limit'> {
  const countRows = (await db.execute(sql`
    SELECT count(*)::int AS count
    FROM api_tokens
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `)) as unknown as { count: number }[];
  if ((countRows[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
    return 'token_limit';
  }

  const minted = generateToken();
  const id = uuidv7();
  const createdAt = new Date();
  await db.insert(apiTokens).values({
    id,
    userId,
    name,
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    scopes,
    createdAt,
    expiresAt: null, // never expires; revoke-only lifecycle
  });

  // CRITICAL: do NOT log the token plaintext, token hash, or response body.
  return {
    token: minted.token,
    summary: toSummary({
      id,
      name,
      tokenPrefix: minted.tokenPrefix,
      scopes,
      createdAt,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    }),
  };
}

/**
 * Revokes a token owned by `userId`. Returns false when no such token exists
 * for that user (callers respond 404 — don't distinguish "not yours" from
 * "doesn't exist"). Idempotent: revoking an already-revoked token succeeds.
 */
export async function revokeTokenForUser(userId: string, id: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT id FROM api_tokens
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `)) as unknown as { id: string }[];
  if (rows.length === 0) return false;

  const revoked = (await db.execute(sql`
    UPDATE api_tokens
    SET revoked_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING token_hash
  `)) as unknown as { token_hash: string }[];
  // Open connections made with this token close now.
  for (const row of revoked) await recheckAccess({ credentialHash: row.token_hash });
  return true;
}
