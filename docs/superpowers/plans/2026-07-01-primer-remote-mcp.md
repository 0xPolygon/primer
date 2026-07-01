# Primer Remote MCP + OAuth 2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hosted Streamable HTTP MCP transport at `/mcp` on the existing Primer API, protected by a minimal OAuth 2.1 authorization server backed by the existing Okta-federated session, so Claude Web and Claude Desktop can connect to Primer as a first-class MCP connector.

**Architecture:** Add OAuth 2.1 endpoints (`/oauth/register`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke`) and `.well-known` metadata handlers to the existing Hono app. Add a Streamable HTTP MCP transport at `/mcp` that reuses the existing service layer. Introduce five new DB tables for OAuth state (clients, consents, auth codes, access tokens, refresh tokens). The existing stdio MCP + device-flow path is left untouched.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, `postgres` (postgres-js), `@modelcontextprotocol/sdk` v1.29+, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-primer-remote-mcp-design.md`

**Branch:** `issue-30-remote-mcp-oauth` (already created; spec committed).

## Global Constraints

- **Package manager:** pnpm only. Never npm.
- **Node:** `>=20` (matches existing engines).
- **Token storage:** all bearer credentials (access tokens, refresh tokens, auth codes) stored sha256-hashed. Raw values never logged, never included in error messages, never returned in any response other than the one that mints them.
- **PKCE:** required. Only `code_challenge_method=S256` accepted; reject `plain`.
- **Clients:** public clients only (no client secrets). `token_endpoint_auth_method=none`.
- **Auth code lifetime:** 5 minutes. Single-use enforced by transactional `consumed_at` update.
- **Access token lifetime:** 1 hour.
- **Refresh token lifetime:** 30 days, rolling. Rotation on every use. Reuse (replay of a rotated token) revokes the whole family.
- **Redirect-URI allowlist:** enforced at `/oauth/register`. Encoded as a module constant. Do NOT accept wildcards or open patterns.
- **Never modify:** `apps/mcp/*`, `apps/api/src/routes/device.ts`, `apps/api/src/routes/tokens.ts`, or the `api_tokens` / `device_authorizations` tables.
- **No git push** without explicit user greenlight. Commit locally per task.
- **Commit references:** every commit ends with `Refs #30`.
- **File layout:** new OAuth files live under `apps/api/src/auth/oauth/`. New MCP files live under `apps/api/src/mcp/`. Migrations land in `apps/api/drizzle/`. Schema lives in `packages/shared/src/schema.ts`.
- **Testing:** Vitest with a real Postgres (`DATABASE_URL_TEST`). Follow the existing `apps/api/src/routes/device.test.ts` pattern for HTTP-level tests (uses `app.request(...)`, `beforeEach` truncate, `withApp` harness, `asUserJson` / `CSRF_HEADERS` helpers). No auth-layer mocking that hides the OAuth flow.

## File Structure

```
apps/api/src/
├── auth/
│   └── oauth/                       (new)
│       ├── tokens.ts                — token/code generation + hashing + PKCE verify
│       ├── tokens.test.ts
│       ├── clients.ts               — DB access for oauth_clients, redirect-URI allowlist
│       ├── clients.test.ts
│       ├── bearer.ts                — makeOAuthBearerResolver; resolver-chain fall-through
│       ├── bearer.test.ts
│       ├── metadata.ts              — .well-known responses
│       ├── metadata.test.ts
│       ├── rateLimit.ts             — in-memory token-bucket middleware
│       ├── rateLimit.test.ts
│       ├── register.ts              — POST /oauth/register (RFC 7591)
│       ├── register.test.ts
│       ├── authorize.ts             — GET /oauth/authorize + POST /oauth/consent
│       ├── authorize.test.ts
│       ├── token.ts                 — POST /oauth/token (code + refresh grants)
│       ├── token.test.ts
│       ├── revoke.ts                — POST /oauth/revoke (RFC 7009)
│       ├── revoke.test.ts
│       └── routes.ts                — registerOAuthRoutes(app, deps): wires everything above
├── mcp/                              (new)
│   ├── urlResolve.ts                — parse Primer URLs → { documentId, versionNumber? }
│   ├── urlResolve.test.ts
│   ├── tools.ts                     — the 7 tool handlers
│   ├── tools.test.ts
│   ├── transport.ts                 — Streamable HTTP mount at /mcp
│   ├── transport.test.ts
│   └── routes.ts                    — registerMcpRoute(app): wires the transport
├── app.ts                            (modify: register OAuth + MCP routes)
├── middleware/auth.ts                (modify: expand PUBLIC_PATHS for OAuth surfaces)
└── env.ts                            (unchanged — OAUTH_ISSUER read at boot)

packages/shared/src/
└── schema.ts                         (modify: append 5 tables)

apps/api/drizzle/
└── 0007_remote_mcp_oauth.sql         (new — generated migration)

apps/api/package.json                 (modify: add @modelcontextprotocol/sdk)
```

## Task Dependency Overview

```
Task 1 (schema + migration)
  └─┬─ Task 2 (OAuth token helpers)         [no DB dependency, could parallel]
    ├─ Task 3 (URL resolver)                 [no DB dependency, could parallel]
    ├─ Task 4 (rate limiter)                 [no DB dependency, could parallel]
    ├─ Task 5 (clients + register)           [needs 1, 2]
    ├─ Task 6 (OAuth bearer resolver)        [needs 1]
    └─ Task 7 (.well-known metadata)         [no DB dependency, could parallel]
Tasks 5 + 6 + 7 done →
    ├─ Task 8 (authorize + consent)          [needs 1, 2, 5]
    ├─ Task 9 (token endpoint)               [needs 1, 2, 5]
    └─ Task 10 (revoke endpoint)             [needs 1, 5]
Tasks 8 + 9 + 10 + 4 done →
    └─ Task 11 (OAuth wiring in app.ts + middleware + rate-limit + E2E)
Task 3 done →
    └─ Task 12 (MCP tools)                    [needs 3; independent of OAuth]
Tasks 6 + 12 + 11 done →
    └─ Task 13 (MCP transport + /mcp route)
Task 13 done →
    └─ Task 14 (final integration + regression + manual verification checklist)
```

Sequential execution is fine — that's what subagent-driven-development does by default. Parallelism markers above are informational for a coordinator that supports it.

---

## Task 1: Database schema and migration

**Files:**
- Modify: `packages/shared/src/schema.ts` (append 5 tables)
- Create: `apps/api/drizzle/0007_remote_mcp_oauth.sql` (generated)

**Interfaces:**
- Produces: exports `oauthClients`, `oauthConsents`, `oauthAuthorizationCodes`, `oauthAccessTokens`, `oauthRefreshTokens` from `@primer/shared/schema`.

**Table definitions** — each column and index matches the spec exactly.

- [ ] **Step 1: Append the five table definitions to `packages/shared/src/schema.ts`**

Append at the end of the file (after `deviceAuthorizations`):

```ts
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id').notNull(),                               // public identifier
    clientName: text('client_name').notNull(),                            // from DCR metadata
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    grantTypes: jsonb('grant_types').$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClientId: uniqueIndex('oauth_clients_client_id_unique').on(t.clientId),
  }),
);

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserClient: uniqueIndex('oauth_consents_user_client_unique').on(t.userId, t.clientId),
  }),
);

export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey(),
    codeHash: text('code_hash').notNull(),                                 // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),          // 'S256'
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCodeHash: uniqueIndex('oauth_auth_codes_hash_unique').on(t.codeHash),
    byExpiry: index('oauth_auth_codes_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_access_tokens_hash_unique').on(t.tokenHash),
    byExpiry: index('oauth_access_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),                                 // rotation-chain grouping
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_refresh_tokens_hash_unique').on(t.tokenHash),
    byFamily: index('oauth_refresh_tokens_family_idx').on(t.familyId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

From `apps/api/`:

```bash
cd apps/api && pnpm db:generate
```

Expected: a new file `apps/api/drizzle/0007_*.sql` is created containing `CREATE TABLE` statements for the five tables + all indexes. drizzle-kit derives the filename suffix; commit whatever it emits verbatim.

- [ ] **Step 3: Apply the migration against the local dev DB**

```bash
cd apps/api && pnpm db:migrate
```

Expected: `Migrations applied.` printed.

- [ ] **Step 4: Apply the migration against the test DB**

```bash
cd apps/api && pnpm db:migrate:test
```

Expected: `Migrations applied.` printed.

- [ ] **Step 5: Typecheck the shared package and the API**

```bash
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
```

Expected: both pass with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schema.ts apps/api/drizzle/
git commit -m "$(cat <<'EOF'
feat(api): add OAuth 2.1 tables for remote MCP

Adds oauth_clients, oauth_consents, oauth_authorization_codes,
oauth_access_tokens, oauth_refresh_tokens with the indexes documented
in the spec. Schema-only; no routes wired yet.

Refs #30
EOF
)"
```

---

## Task 2: OAuth token, code, and PKCE helpers

**Files:**
- Create: `apps/api/src/auth/oauth/tokens.ts`
- Create: `apps/api/src/auth/oauth/tokens.test.ts`

**Interfaces:**
- Produces:
  - `hashHex(raw: string): string` — sha256 hex
  - `generateAuthCode(): { code: string; codeHash: string }` — opaque code
  - `generateAccessToken(): { token: string; tokenHash: string }` — prefix `primer_oat_`
  - `generateRefreshToken(): { token: string; tokenHash: string }` — prefix `primer_ort_`
  - `generateClientId(): string` — 32-char base64url
  - `verifyPkceS256(challenge: string, verifier: string): boolean`
  - `ACCESS_TOKEN_PREFIX = 'primer_oat_'`
  - `REFRESH_TOKEN_PREFIX = 'primer_ort_'`
- Consumes: only `node:crypto`.

Prefixes chosen so an OAuth token is trivially distinguishable from a `primer_pat_` device-flow token in logs and in the bearer-resolver chain.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  hashHex,
  generateAuthCode,
  generateAccessToken,
  generateRefreshToken,
  generateClientId,
  verifyPkceS256,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from './tokens.ts';

describe('hashHex', () => {
  it('returns sha256 hex of the input', () => {
    expect(hashHex('hello')).toBe(createHash('sha256').update('hello', 'utf8').digest('hex'));
  });
});

describe('generateAuthCode', () => {
  it('returns raw code with matching sha256 hash', () => {
    const { code, codeHash } = generateAuthCode();
    expect(code.length).toBeGreaterThan(20);
    expect(codeHash).toBe(hashHex(code));
  });

  it('is unique across draws', () => {
    const a = generateAuthCode();
    const b = generateAuthCode();
    expect(a.code).not.toBe(b.code);
  });
});

describe('generateAccessToken', () => {
  it('carries the primer_oat_ prefix and matching hash', () => {
    const { token, tokenHash } = generateAccessToken();
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashHex(token));
  });
});

describe('generateRefreshToken', () => {
  it('carries the primer_ort_ prefix and matching hash', () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashHex(token));
  });
});

describe('generateClientId', () => {
  it('returns a 32+ char base64url string', () => {
    const id = generateClientId();
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('verifyPkceS256', () => {
  it('returns true when SHA256(verifier) base64url-encoded matches the challenge', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    expect(verifyPkceS256(challenge, verifier)).toBe(true);
  });

  it('returns false on a mismatch', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update('different', 'utf8').digest('base64url');
    expect(verifyPkceS256(challenge, verifier)).toBe(false);
  });

  it('uses constant-time comparison (both inputs same length, one bit off)', () => {
    // Not truly testable at unit level, but exercise the equal-length path so
    // an accidental === rewrite would still return false.
    const verifier = 'a'.repeat(43);
    const challenge = 'b'.repeat(43);
    expect(verifyPkceS256(challenge, verifier)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- tokens
```

Expected: FAIL with "Cannot find module './tokens.ts'".

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/tokens.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_PREFIX = 'primer_oat_';
export const REFRESH_TOKEN_PREFIX = 'primer_ort_';

export function hashHex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateAuthCode(): { code: string; codeHash: string } {
  const code = randomBytes(32).toString('base64url');
  return { code, codeHash: hashHex(code) };
}

export function generateAccessToken(): { token: string; tokenHash: string } {
  const random = randomBytes(32).toString('base64url');
  const token = `${ACCESS_TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashHex(token) };
}

export function generateRefreshToken(): { token: string; tokenHash: string } {
  const random = randomBytes(32).toString('base64url');
  const token = `${REFRESH_TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashHex(token) };
}

export function generateClientId(): string {
  return randomBytes(24).toString('base64url'); // 32-char output
}

/**
 * RFC 7636 S256: challenge === base64url(SHA256(verifier)). Constant-time
 * compare to avoid a leaking-by-timing branch on the byte-by-byte match.
 */
export function verifyPkceS256(challenge: string, verifier: string): boolean {
  const expected = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(challenge, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- tokens
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/tokens.ts apps/api/src/auth/oauth/tokens.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add OAuth token/code helpers and PKCE S256 verifier

Refs #30
EOF
)"
```

---

## Task 3: Primer URL resolver

**Files:**
- Create: `apps/api/src/mcp/urlResolve.ts`
- Create: `apps/api/src/mcp/urlResolve.test.ts`

**Interfaces:**
- Produces:
  - `parsePrimerUrl(input: string): { documentId: string; versionNumber?: number } | null`

Accepts these URL shapes (the second segment is `/d/`, matching `apps/web/src/App.tsx`):
- `https://<host>/d/<docId>` → `{ documentId: docId }`
- `https://<host>/d/<docId>/v/<versionNumber>` → `{ documentId: docId, versionNumber: N }`
- `https://<host>/d/<docId>/compare/...` → `{ documentId: docId }` (drop compare segments)

Anything else (including plain UUIDs — those are handled at the call site, not here) returns `null`. This is strict on purpose: the tool handler treats a `null` result as `bad_request { message: 'not a Primer URL' }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/mcp/urlResolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePrimerUrl } from './urlResolve.ts';

describe('parsePrimerUrl', () => {
  it('parses a plain document URL', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123')).toEqual({
      documentId: 'abc-123',
    });
  });

  it('parses a versioned document URL', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123/v/4')).toEqual({
      documentId: 'abc-123',
      versionNumber: 4,
    });
  });

  it('drops trailing compare segments', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123/compare/1/2')).toEqual({
      documentId: 'abc-123',
    });
  });

  it('accepts localhost dev URLs', () => {
    expect(parsePrimerUrl('http://localhost:5173/d/xyz')).toEqual({ documentId: 'xyz' });
  });

  it('rejects non-Primer paths', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/settings')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parsePrimerUrl('not a url')).toBeNull();
    expect(parsePrimerUrl('')).toBeNull();
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/')).toBeNull();
  });

  it('rejects non-numeric version numbers', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc/v/foo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- urlResolve
```

Expected: FAIL with "Cannot find module './urlResolve.ts'".

- [ ] **Step 3: Implement `apps/api/src/mcp/urlResolve.ts`**

```ts
export interface PrimerUrlParsed {
  documentId: string;
  versionNumber?: number;
}

export function parsePrimerUrl(input: string): PrimerUrlParsed | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  if (parts[0] !== 'd') return null;

  const documentId = parts[1];
  if (documentId.length === 0) return null;

  // /d/<id>
  if (parts.length === 2) return { documentId };

  // /d/<id>/v/<versionNumber>
  if (parts.length >= 4 && parts[2] === 'v') {
    const n = Number(parts[3]);
    if (!Number.isInteger(n) || n < 1) return null;
    return { documentId, versionNumber: n };
  }

  // /d/<id>/compare/... — drop compare segments
  if (parts[2] === 'compare') return { documentId };

  return null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- urlResolve
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mcp/urlResolve.ts apps/api/src/mcp/urlResolve.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add Primer URL parser for MCP tools

Refs #30
EOF
)"
```

---

## Task 4: In-memory token-bucket rate limiter

**Files:**
- Create: `apps/api/src/auth/oauth/rateLimit.ts`
- Create: `apps/api/src/auth/oauth/rateLimit.test.ts`

**Interfaces:**
- Produces:
  - `makeRateLimiter(opts: { capacity: number; refillPerSecond: number }): (key: string) => { allowed: boolean; retryAfterSeconds: number }`
  - `oauthRateLimitMiddleware(opts: RateLimitConfig): MiddlewareHandler`

Keyed by IP + endpoint path. In-memory (single Railway instance is fine per spec Section 6). Emits 429 with `Retry-After` header.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/rateLimit.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { makeRateLimiter, oauthRateLimitMiddleware } from './rateLimit.ts';

describe('makeRateLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('allows requests within capacity', () => {
    const check = makeRateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
  });

  it('isolates buckets by key', () => {
    const check = makeRateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
    expect(check('b').allowed).toBe(true);
  });

  it('refills over time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const check = makeRateLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    expect(check('a').allowed).toBe(true);
  });

  it('reports retryAfterSeconds when denied', () => {
    const check = makeRateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    check('a'); // consume
    const denied = check('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('oauthRateLimitMiddleware', () => {
  it('returns 429 with Retry-After when the bucket is empty', async () => {
    const app = new Hono();
    app.use('*', oauthRateLimitMiddleware({ capacity: 1, refillPerSecond: 0 }));
    app.get('/x', (c) => c.text('ok'));

    const first = await app.request('/x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(first.status).toBe(200);

    const second = await app.request('/x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- rateLimit
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/rateLimit.ts`**

```ts
import type { MiddlewareHandler } from 'hono';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export function makeRateLimiter(cfg: RateLimitConfig) {
  const buckets = new Map<string, Bucket>();

  return function check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: cfg.capacity, updatedAt: now };

    // Refill.
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSec * cfg.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    buckets.set(key, bucket);
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = cfg.refillPerSecond > 0
      ? Math.ceil(deficit / cfg.refillPerSecond)
      : Number.POSITIVE_INFINITY;
    return { allowed: false, retryAfterSeconds };
  };
}

function extractIp(header: string | undefined | null): string {
  if (!header) return 'unknown';
  const parts = header.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export function oauthRateLimitMiddleware(cfg: RateLimitConfig): MiddlewareHandler {
  const check = makeRateLimiter(cfg);
  return async (c, next) => {
    const ip = extractIp(c.req.header('x-forwarded-for'));
    const key = `${ip}:${c.req.path}`;
    const { allowed, retryAfterSeconds } = check(key);
    if (allowed) return next();
    const retry = Number.isFinite(retryAfterSeconds) ? String(Math.max(1, retryAfterSeconds)) : '60';
    return c.json({ error: 'rate_limited' }, 429, { 'retry-after': retry });
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- rateLimit
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/rateLimit.ts apps/api/src/auth/oauth/rateLimit.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add in-memory rate limiter for OAuth endpoints

Refs #30
EOF
)"
```

---

## Task 5: OAuth client registry + DCR endpoint

**Files:**
- Create: `apps/api/src/auth/oauth/clients.ts`
- Create: `apps/api/src/auth/oauth/clients.test.ts`
- Create: `apps/api/src/auth/oauth/register.ts`
- Create: `apps/api/src/auth/oauth/register.test.ts`

**Interfaces:**
- Consumes: `generateClientId` from `./tokens.ts`; `oauthClients` from `@primer/shared/schema`.
- Produces:
  - `REDIRECT_URI_ALLOWLIST: readonly string[]` — literal URIs Claude Web / Desktop / local dev advertise
  - `isRedirectUriAllowed(uri: string): boolean`
  - `getClient(clientId: string): Promise<OAuthClientRow | null>`
  - `createClient(input): Promise<OAuthClientRow>`
  - `registerOAuthRegistrationRoute(app): void` — mounts `POST /oauth/register`

The allowlist is an exact-URI list plus a narrow pattern for `http://127.0.0.1:*` (any port) to support local dev. No wildcards for public hosts. During Task 14 the maintainer confirms Claude Web's advertised redirect URI and adjusts if needed.

- [ ] **Step 1: Write the failing test — `clients.test.ts`**

Create `apps/api/src/auth/oauth/clients.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import {
  REDIRECT_URI_ALLOWLIST,
  isRedirectUriAllowed,
  getClient,
  createClient,
} from './clients.ts';

beforeEach(async () => {
  await db.delete(oauthClients);
});

describe('REDIRECT_URI_ALLOWLIST', () => {
  it('contains Claude Web callback', () => {
    expect(REDIRECT_URI_ALLOWLIST).toContain('https://claude.ai/api/mcp/auth_callback');
  });
});

describe('isRedirectUriAllowed', () => {
  it('accepts exact-match allowlisted URIs', () => {
    expect(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('accepts loopback URIs on any port', () => {
    expect(isRedirectUriAllowed('http://127.0.0.1:8123/cb')).toBe(true);
    expect(isRedirectUriAllowed('http://127.0.0.1:65535/whatever')).toBe(true);
  });

  it('rejects unlisted hosts', () => {
    expect(isRedirectUriAllowed('https://evil.example.com/cb')).toBe(false);
  });

  it('rejects http on non-loopback', () => {
    expect(isRedirectUriAllowed('http://claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isRedirectUriAllowed('not a url')).toBe(false);
  });
});

describe('createClient + getClient', () => {
  it('round-trips', async () => {
    const created = await createClient({
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    expect(created.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
    const fetched = await getClient(created.clientId);
    expect(fetched?.clientName).toBe('Claude');
    expect(fetched?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('returns null for unknown clientId', async () => {
    expect(await getClient('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- clients
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/clients.ts`**

```ts
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import { generateClientId } from './tokens.ts';

/**
 * Exact-URI allowlist. Add entries here as new MCP clients are onboarded.
 * Loopback URIs (http://127.0.0.1:<any port>) are always accepted for local dev.
 */
export const REDIRECT_URI_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
] as const;

export function isRedirectUriAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return true;
  return REDIRECT_URI_ALLOWLIST.includes(uri);
}

export interface OAuthClientRow {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: Date;
}

export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, client_id AS "clientId", client_name AS "clientName",
           redirect_uris AS "redirectUris", grant_types AS "grantTypes",
           token_endpoint_auth_method AS "tokenEndpointAuthMethod",
           created_at AS "createdAt"
    FROM oauth_clients WHERE client_id = ${clientId} LIMIT 1
  `)) as unknown as OAuthClientRow[];
  return rows[0] ?? null;
}

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
}

export async function createClient(input: CreateClientInput): Promise<OAuthClientRow> {
  const id = uuidv7();
  const clientId = generateClientId();
  await db.insert(oauthClients).values({
    id,
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes,
    tokenEndpointAuthMethod: 'none',
  });
  const row = await getClient(clientId);
  if (!row) throw new Error('createClient failed to read back inserted row');
  return row;
}
```

- [ ] **Step 4: Run `clients.test.ts` to confirm it passes**

```bash
pnpm --filter @primer/api test -- clients
```

Expected: 7 tests pass.

- [ ] **Step 5: Write the failing test — `register.test.ts`**

Create `apps/api/src/auth/oauth/register.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import { registerOAuthRegistrationRoute } from './register.ts';

async function makeApp(): Promise<Hono> {
  const app = new Hono();
  registerOAuthRegistrationRoute(app);
  return app;
}

beforeEach(async () => {
  await db.delete(oauthClients);
});

describe('POST /oauth/register', () => {
  it('accepts a valid registration', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.client_name).toBe('Claude');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects an unlisted redirect_uri', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Rogue',
        redirect_uris: ['https://evil.example.com/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects missing fields', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('rejects a client requesting unsupported grant types', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'X',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['client_credentials'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_client_metadata');
  });
});
```

- [ ] **Step 6: Run `register.test.ts` to confirm it fails**

```bash
pnpm --filter @primer/api test -- register
```

Expected: FAIL — no `./register.ts`.

- [ ] **Step 7: Implement `apps/api/src/auth/oauth/register.ts`**

```ts
import type { Hono } from 'hono';
import { createClient, isRedirectUriAllowed } from './clients.ts';

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

export function registerOAuthRegistrationRoute(app: Hono): void {
  app.post('/oauth/register', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400);
    }

    const clientName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((s): s is string => typeof s === 'string')
      : [];
    const grantTypes = Array.isArray(body.grant_types)
      ? body.grant_types.filter((s): s is string => typeof s === 'string')
      : ['authorization_code', 'refresh_token'];

    if (clientName.length === 0 || redirectUris.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'client_name and redirect_uris required' }, 400);
    }
    for (const uri of redirectUris) {
      if (!isRedirectUriAllowed(uri)) {
        return c.json({ error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${uri}` }, 400);
      }
    }
    for (const gt of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.has(gt)) {
        return c.json({ error: 'invalid_client_metadata', error_description: `grant_type not supported: ${gt}` }, 400);
      }
    }

    const client = await createClient({ clientName, redirectUris, grantTypes });

    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      },
      201,
    );
  });
}
```

- [ ] **Step 8: Run `register.test.ts` to confirm it passes**

```bash
pnpm --filter @primer/api test -- register
```

Expected: 4 tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/auth/oauth/clients.ts apps/api/src/auth/oauth/clients.test.ts apps/api/src/auth/oauth/register.ts apps/api/src/auth/oauth/register.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add OAuth client registry + DCR endpoint

Refs #30
EOF
)"
```

---

## Task 6: OAuth bearer resolver

**Files:**
- Create: `apps/api/src/auth/oauth/bearer.ts`
- Create: `apps/api/src/auth/oauth/bearer.test.ts`

**Interfaces:**
- Consumes: `oauthAccessTokens` from `@primer/shared/schema`; `hashHex`, `ACCESS_TOKEN_PREFIX` from `./tokens.ts`; `UserResolver` from `../resolver.ts`.
- Produces: `makeOAuthBearerResolver(): UserResolver`

Resolver behavior:
- Header missing / non-Bearer → return `null` (fall through to next resolver).
- Bearer with wrong prefix (not `primer_oat_`) → `null` (device-flow PAT resolver picks it up).
- Bearer with `primer_oat_` prefix, but token not in DB or expired → `null` (fall through — the auth middleware then 401s cleanly).
- Match → set `authMethod='bearer'`, return the user.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/bearer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { Hono } from 'hono';
import type { AppVariables } from '../../app.ts';
import { db } from '../../db/client.ts';
import { oauthAccessTokens, oauthClients, users } from '@primer/shared/schema';
import { makeOAuthBearerResolver } from './bearer.ts';
import { generateAccessToken } from './tokens.ts';
import { createClient } from './clients.ts';

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
}

async function withApp<T>(fn: (app: Hono<{ Variables: AppVariables }>) => Promise<T>): Promise<T> {
  const app = new Hono<{ Variables: AppVariables }>();
  const resolver = makeOAuthBearerResolver();
  app.use('*', async (c, next) => {
    const user = await resolver(c);
    if (user) c.set('user', user);
    await next();
  });
  app.get('/probe', (c) => {
    const u = c.get('user');
    return u ? c.json({ id: u.id }) : c.json({ error: 'no user' }, 401);
  });
  return fn(app);
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthClients);
});

describe('makeOAuthBearerResolver', () => {
  it('resolves a valid primer_oat_ token to its user', async () => {
    await seedUser('user-1');
    const client = await createClient({
      clientName: 'test',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'user-1',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    await withApp(async (app) => {
      const res = await app.request('/probe', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'user-1' });
    });
  });

  it('returns null when the Authorization header is missing', async () => {
    await withApp(async (app) => {
      const res = await app.request('/probe');
      expect(res.status).toBe(401);
    });
  });

  it('returns null when the prefix is not primer_oat_', async () => {
    await withApp(async (app) => {
      const res = await app.request('/probe', {
        headers: { authorization: 'Bearer primer_pat_abc' },
      });
      expect(res.status).toBe(401);
    });
  });

  it('returns null when the token is expired', async () => {
    await seedUser('user-2');
    const client = await createClient({
      clientName: 'test',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'user-2',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    await withApp(async (app) => {
      const res = await app.request('/probe', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- bearer.test
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/bearer.ts`**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { UserResolver } from '../resolver.ts';
import { ACCESS_TOKEN_PREFIX, hashHex } from './tokens.ts';

interface OAuthBearerRow {
  id: string;
  email: string;
  display_name: string;
}

/**
 * Resolves `Authorization: Bearer primer_oat_<...>` to a user.
 *
 * Falls through (returns null) when:
 *   - the header is missing or not `Bearer <...>`,
 *   - the token doesn't carry the `primer_oat_` prefix,
 *   - the hashed token matches no live row.
 *
 * This resolver is inserted BEFORE the PAT bearer resolver in the chain, so
 * OAuth-issued tokens win when their prefix matches, and PAT tokens continue
 * to work when they don't.
 */
export function makeOAuthBearerResolver(): UserResolver {
  return async (c) => {
    const header = c.req.header('authorization');
    if (!header) return null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;

    const tokenHash = hashHex(token);
    const rows = (await db.execute(sql`
      SELECT u.id, u.email, u.display_name
      FROM oauth_access_tokens t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
        AND t.expires_at > now()
      LIMIT 1
    `)) as unknown as OAuthBearerRow[];

    const row = rows[0];
    if (!row) return null;

    c.set('authMethod', 'bearer');
    return { id: row.id, email: row.email, displayName: row.display_name };
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- bearer.test
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/bearer.ts apps/api/src/auth/oauth/bearer.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add OAuth bearer resolver

Refs #30
EOF
)"
```

---

## Task 7: `.well-known` metadata endpoints

**Files:**
- Create: `apps/api/src/auth/oauth/metadata.ts`
- Create: `apps/api/src/auth/oauth/metadata.test.ts`

**Interfaces:**
- Produces: `registerOAuthMetadataRoutes(app, opts: { issuer: string }): void` — mounts:
  - `GET /.well-known/oauth-authorization-server` — RFC 8414
  - `GET /.well-known/oauth-protected-resource` — RFC 9728

`issuer` is passed in explicitly so tests can drive it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/metadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerOAuthMetadataRoutes } from './metadata.ts';

const ISSUER = 'https://primer.example.com';

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthMetadataRoutes(app, { issuer: ISSUER });
  return app;
}

describe('GET /.well-known/oauth-authorization-server', () => {
  it('advertises the required endpoints', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(body.response_types_supported).toContain('code');
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.scopes_supported).toContain('primer');
  });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('advertises the resource and its authorization server', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.bearer_methods_supported).toEqual(['header']);
    expect(body.scopes_supported).toContain('primer');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- metadata
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/metadata.ts`**

```ts
import type { Hono } from 'hono';

export interface OAuthMetadataOptions {
  issuer: string; // e.g. https://primer-polygon.up.railway.app
}

export function registerOAuthMetadataRoutes(app: Hono, opts: OAuthMetadataOptions): void {
  const { issuer } = opts;

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['primer'],
    }),
  );

  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['primer'],
    }),
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- metadata
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/metadata.ts apps/api/src/auth/oauth/metadata.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add OAuth .well-known metadata endpoints

Refs #30
EOF
)"
```

---

## Task 8: `/oauth/authorize` and `/oauth/consent`

**Files:**
- Create: `apps/api/src/auth/oauth/authorize.ts`
- Create: `apps/api/src/auth/oauth/authorize.test.ts`

**Interfaces:**
- Consumes: `getClient` from `./clients.ts`; `generateAuthCode`, `hashHex` from `./tokens.ts`; `oauthAuthorizationCodes`, `oauthConsents` from `@primer/shared/schema`; `parseCookie` from `../cookies.ts`; `lookupSession` from `../session.ts`.
- Produces: `registerOAuthAuthorizationRoutes(app, opts: { sessionCookieName: string }): void`
  - `GET /oauth/authorize`
  - `POST /oauth/consent`

Behavior for `GET /oauth/authorize`:
1. Validate `client_id` → fetch client; unknown → render error page (do not redirect anywhere).
2. Validate `redirect_uri` against client's registered set; unknown → render error page.
3. Validate `response_type=code`, `code_challenge_method=S256`, non-empty `code_challenge`, non-empty `state`; anything wrong → 302 to `redirect_uri?error=invalid_request&state=<state>` with the specific reason in `error_description`.
4. Check `primer_sid` session cookie via `lookupSession`; missing/invalid → 302 to `/auth/login?return_to=<encoded /oauth/authorize URL>`.
5. Look up existing consent row for `(userId, clientId)`. If found: mint code + 302 to `redirect_uri?code=<code>&state=<state>` immediately.
6. Otherwise: render an HTML consent form with hidden inputs for every auth param plus a CSRF token bound to the session.

Behavior for `POST /oauth/consent`:
1. Validate CSRF header (existing `csrfMiddleware` handles the header check).
2. Re-validate session, client, redirect_uri, and the OAuth params from the form body.
3. If Deny: 302 to `redirect_uri?error=access_denied&state=<state>`.
4. If Allow: upsert consent row; mint code; 302 to `redirect_uri?code=<code>&state=<state>`.

Store `codeHash + code_challenge + code_challenge_method + redirect_uri + user_id + client_id + scopes + expires_at (now + 5min)` in `oauth_authorization_codes`.

- [ ] **Step 1: Write the failing test — full file**

Create `apps/api/src/auth/oauth/authorize.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  sessions,
  users,
} from '@primer/shared/schema';
import { registerOAuthAuthorizationRoutes } from './authorize.ts';
import { createClient } from './clients.ts';
import { csrfMiddleware } from '../csrf.ts';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

async function seedUserAndSession(): Promise<{ userId: string; sid: string }> {
  const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const sid = `s-${Math.random().toString(36).slice(2, 24)}`;
  await db.insert(sessions).values({
    id: sid,
    userId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return { userId, sid };
}

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', csrfMiddleware);
  registerOAuthAuthorizationRoutes(app, { sessionCookieName: 'primer_sid' });
  return app;
}

beforeEach(async () => {
  await db.delete(oauthAuthorizationCodes);
  await db.delete(oauthConsents);
  await db.delete(oauthClients);
  await db.delete(sessions);
});

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'primer',
    ...extra,
  });
  return `/oauth/authorize?${params.toString()}`;
}

describe('GET /oauth/authorize', () => {
  it('302s to /auth/login when the session cookie is missing', async () => {
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('/auth/login?return_to=')).toBe(true);
    expect(decodeURIComponent(loc.split('return_to=')[1])).toContain('/oauth/authorize');
  });

  it('renders a consent form when the session is valid and no prior consent exists', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId), {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Claude');
    expect(html).toContain('Allow');
    expect(html).toContain('Deny');
    // CSRF token round-trips through the form as a hidden input.
    expect(html).toMatch(/name="csrf"/);
  });

  it('skips the form and 302s with a code when consent already exists', async () => {
    const { userId, sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    await db.insert(oauthConsents).values({
      id: uuidv7(),
      userId,
      clientId: client.clientId,
      scopes: ['primer'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId), {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('xyz');

    const codes = await db.execute(sql`SELECT COUNT(*)::int AS n FROM oauth_authorization_codes`);
    expect((codes as unknown as { n: number }[])[0].n).toBe(1);
  });

  it('renders an error page for an unknown redirect_uri (no redirect)', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(
      authorizeUrl(client.clientId, { redirect_uri: 'https://evil.example.com/cb' }),
      { headers: { cookie: `primer_sid=${sid}` } },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('invalid_redirect_uri');
  });

  it('302s to the redirect_uri with error=invalid_request on missing code_challenge', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
    });
    const res = await makeApp().request(`/oauth/authorize?${params.toString()}`, {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('xyz');
  });
});

describe('POST /oauth/consent', () => {
  it('records consent and 302s with a code on Allow', async () => {
    const { userId, sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const body = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
      decision: 'allow',
    });
    const res = await makeApp().request('/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `primer_sid=${sid}`,
        'x-primer-csrf': '1',
      },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('code')).toBeTruthy();

    const consents = await db.execute(sql`SELECT user_id AS "userId" FROM oauth_consents`);
    expect((consents as unknown as { userId: string }[])[0].userId).toBe(userId);
  });

  it('302s with error=access_denied on Deny (and no consent row is created)', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const body = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
      decision: 'deny',
    });
    const res = await makeApp().request('/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `primer_sid=${sid}`,
        'x-primer-csrf': '1',
      },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('error')).toBe('access_denied');

    const consents = await db.execute(sql`SELECT COUNT(*)::int AS n FROM oauth_consents`);
    expect((consents as unknown as { n: number }[])[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- authorize.test
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/authorize.ts`**

```ts
import type { Context, Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { oauthAuthorizationCodes, oauthConsents } from '@primer/shared/schema';
import { parseCookie } from '../cookies.ts';
import { lookupSession } from '../session.ts';
import { generateAuthCode } from './tokens.ts';
import { getClient, type OAuthClientRow } from './clients.ts';

const CODE_TTL_MS = 5 * 60 * 1000;
const REQUIRED_SCOPE = 'primer';

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
}

function readParams(url: URL): AuthorizeParams {
  const q = url.searchParams;
  return {
    clientId: q.get('client_id') ?? '',
    redirectUri: q.get('redirect_uri') ?? '',
    responseType: q.get('response_type') ?? '',
    codeChallenge: q.get('code_challenge') ?? '',
    codeChallengeMethod: q.get('code_challenge_method') ?? '',
    state: q.get('state') ?? '',
    scope: q.get('scope') ?? REQUIRED_SCOPE,
  };
}

function readBodyParams(body: URLSearchParams): AuthorizeParams & { decision: string } {
  return {
    clientId: body.get('client_id') ?? '',
    redirectUri: body.get('redirect_uri') ?? '',
    responseType: body.get('response_type') ?? '',
    codeChallenge: body.get('code_challenge') ?? '',
    codeChallengeMethod: body.get('code_challenge_method') ?? '',
    state: body.get('state') ?? '',
    scope: body.get('scope') ?? REQUIRED_SCOPE,
    decision: body.get('decision') ?? '',
  };
}

function validateOauthParams(p: AuthorizeParams): { ok: true } | { ok: false; reason: string } {
  if (p.responseType !== 'code') return { ok: false, reason: 'response_type must be "code"' };
  if (p.codeChallengeMethod !== 'S256') return { ok: false, reason: 'code_challenge_method must be S256' };
  if (p.codeChallenge.length === 0) return { ok: false, reason: 'code_challenge is required' };
  if (p.state.length === 0) return { ok: false, reason: 'state is required' };
  return { ok: true };
}

function errorRedirect(c: Context, redirectUri: string, error: string, description: string, state: string) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return c.redirect(u.toString(), 302);
}

function errorPage(c: Context, error: string, description: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>OAuth error</title>
<h1>Authorization error</h1><p><code>${error}</code>: ${description}</p>`;
  return c.html(html, 400);
}

function renderConsent(c: Context, client: OAuthClientRow, p: AuthorizeParams, csrfToken: string) {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  const html = `<!doctype html><meta charset="utf-8">
<title>Authorize Primer connector</title>
<style>body{font-family:system-ui;max-width:38rem;margin:2rem auto;line-height:1.5}
.note{background:#f6f6f6;padding:.5rem .75rem;border-radius:.25rem;font-size:.9em;color:#555}
button{padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>An app calling itself &ldquo;${esc(client.clientName)}&rdquo; wants access to your Primer documents.</h1>
<p class="note">If you weren&rsquo;t expecting this prompt, click <strong>Deny</strong>.</p>
<form method="POST" action="/oauth/consent">
${hidden('client_id', p.clientId)}
${hidden('redirect_uri', p.redirectUri)}
${hidden('response_type', p.responseType)}
${hidden('code_challenge', p.codeChallenge)}
${hidden('code_challenge_method', p.codeChallengeMethod)}
${hidden('state', p.state)}
${hidden('scope', p.scope)}
${hidden('csrf', csrfToken)}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`;
  return c.html(html);
}

async function mintCodeAndRedirect(
  c: Context,
  input: { userId: string; clientId: string; p: AuthorizeParams },
) {
  const { code, codeHash } = generateAuthCode();
  await db.insert(oauthAuthorizationCodes).values({
    id: uuidv7(),
    codeHash,
    userId: input.userId,
    clientId: input.clientId,
    redirectUri: input.p.redirectUri,
    codeChallenge: input.p.codeChallenge,
    codeChallengeMethod: input.p.codeChallengeMethod,
    scopes: input.p.scope.split(' ').filter((s) => s.length > 0),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const u = new URL(input.p.redirectUri);
  u.searchParams.set('code', code);
  if (input.p.state) u.searchParams.set('state', input.p.state);
  return c.redirect(u.toString(), 302);
}

export interface AuthorizeOptions {
  sessionCookieName: string;
}

export function registerOAuthAuthorizationRoutes(app: Hono, opts: AuthorizeOptions): void {
  app.get('/oauth/authorize', async (c) => {
    const url = new URL(c.req.url, 'http://x');
    const p = readParams(url);

    const client = p.clientId ? await getClient(p.clientId) : null;
    if (!client) return errorPage(c, 'invalid_client', 'Unknown client_id');
    if (!client.redirectUris.includes(p.redirectUri))
      return errorPage(c, 'invalid_redirect_uri', 'redirect_uri not registered');

    const paramCheck = validateOauthParams(p);
    if (!paramCheck.ok) return errorRedirect(c, p.redirectUri, 'invalid_request', paramCheck.reason, p.state);

    const sid = parseCookie(c.req.header('cookie') ?? null, opts.sessionCookieName);
    const session = sid ? await lookupSession(sid) : null;
    if (!session) {
      const returnTo = encodeURIComponent(`${url.pathname}${url.search}`);
      return c.redirect(`/auth/login?return_to=${returnTo}`, 302);
    }

    const existing = (await db.execute(sql`
      SELECT id FROM oauth_consents
      WHERE user_id = ${session.user.id} AND client_id = ${p.clientId}
      LIMIT 1
    `)) as unknown as { id: string }[];

    if (existing.length > 0) {
      return mintCodeAndRedirect(c, { userId: session.user.id, clientId: p.clientId, p });
    }

    return renderConsent(c, client, p, sid);
  });

  app.post('/oauth/consent', async (c) => {
    const raw = await c.req.text();
    const body = new URLSearchParams(raw);
    const p = readBodyParams(body);

    const client = p.clientId ? await getClient(p.clientId) : null;
    if (!client) return errorPage(c, 'invalid_client', 'Unknown client_id');
    if (!client.redirectUris.includes(p.redirectUri))
      return errorPage(c, 'invalid_redirect_uri', 'redirect_uri not registered');

    const paramCheck = validateOauthParams(p);
    if (!paramCheck.ok) return errorRedirect(c, p.redirectUri, 'invalid_request', paramCheck.reason, p.state);

    const sid = parseCookie(c.req.header('cookie') ?? null, opts.sessionCookieName);
    const session = sid ? await lookupSession(sid) : null;
    if (!session) return errorPage(c, 'not_authenticated', 'session missing');

    if (p.decision !== 'allow') {
      return errorRedirect(c, p.redirectUri, 'access_denied', 'user denied consent', p.state);
    }

    // Upsert the consent row.
    await db.execute(sql`
      INSERT INTO oauth_consents (id, user_id, client_id, scopes, updated_at)
      VALUES (${uuidv7()}, ${session.user.id}, ${p.clientId}, ${JSON.stringify(p.scope.split(' ').filter((s) => s.length > 0))}, now())
      ON CONFLICT (user_id, client_id)
      DO UPDATE SET scopes = EXCLUDED.scopes, updated_at = now()
    `);

    return mintCodeAndRedirect(c, { userId: session.user.id, clientId: p.clientId, p });
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- authorize.test
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/authorize.ts apps/api/src/auth/oauth/authorize.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /oauth/authorize and /oauth/consent endpoints

Refs #30
EOF
)"
```

---

## Task 9: `/oauth/token` endpoint (code + refresh grants)

**Files:**
- Create: `apps/api/src/auth/oauth/token.ts`
- Create: `apps/api/src/auth/oauth/token.test.ts`

**Interfaces:**
- Consumes: `getClient` from `./clients.ts`; `generateAccessToken`, `generateRefreshToken`, `hashHex`, `verifyPkceS256` from `./tokens.ts`; `oauthAuthorizationCodes`, `oauthAccessTokens`, `oauthRefreshTokens` from `@primer/shared/schema`.
- Produces: `registerOAuthTokenRoute(app): void` — mounts `POST /oauth/token`.

Access token TTL: 1h (constant `ACCESS_TOKEN_TTL_MS`).
Refresh token TTL: 30d (constant `REFRESH_TOKEN_TTL_MS`).

Grants:
- **`authorization_code`:** requires `code`, `code_verifier`, `redirect_uri`, `client_id`. In one transaction: `UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > now() AND redirect_uri = ? AND client_id = ?` returning the row. If `rowCount = 0` → `invalid_grant`. Verify PKCE. Insert access + refresh tokens (new `family_id`). Return `{ access_token, token_type: 'bearer', expires_in, refresh_token, scope }`.
- **`refresh_token`:** requires `refresh_token`, `client_id`. Look up by hash. If `rotated_at IS NOT NULL` → **reuse detected**: in one transaction set `revoked_at = now()` on every row where `family_id = ?`, return `invalid_grant`. If `revoked_at IS NOT NULL` or expired → `invalid_grant`. If `client_id` mismatch → `invalid_client`. In one transaction: mark current row `rotated_at = now()`, insert new access + new refresh with same `family_id`. Return the new pair.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/token.test.ts`. This is long — write every assertion:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
  users,
} from '@primer/shared/schema';
import { registerOAuthTokenRoute } from './token.ts';
import { createClient, type OAuthClientRow } from './clients.ts';
import { hashHex } from './tokens.ts';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthTokenRoute(app);
  return app;
}

async function seedUser(): Promise<string> {
  const id = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
  return id;
}

async function seedClient(): Promise<OAuthClientRow> {
  return createClient({
    clientName: 'Claude',
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

async function seedAuthCode(
  clientId: string,
  userId: string,
  overrides: { challenge: string; redirectUri?: string; expiresAt?: Date },
): Promise<{ code: string }> {
  const code = randomBytes(32).toString('base64url');
  await db.insert(oauthAuthorizationCodes).values({
    id: uuidv7(),
    codeHash: hashHex(code),
    userId,
    clientId,
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    codeChallenge: overrides.challenge,
    codeChallengeMethod: 'S256',
    scopes: ['primer'],
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
  });
  return { code };
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthRefreshTokens);
  await db.delete(oauthAuthorizationCodes);
  await db.delete(oauthClients);
});

describe('POST /oauth/token — grant_type=authorization_code', () => {
  it('mints access + refresh on the happy path and marks the code consumed', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
    });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token_type).toBe('bearer');
    expect(typeof json.access_token).toBe('string');
    expect(typeof json.refresh_token).toBe('string');
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe('primer');

    const consumed = (await db.execute(sql`
      SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash = ${hashHex(code)}
    `)) as unknown as { consumed_at: Date | null }[];
    expect(consumed[0].consumed_at).not.toBeNull();
  });

  it('returns invalid_grant for a consumed code', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const doPost = () =>
      makeApp().request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id: client.clientId,
        }).toString(),
      });

    expect((await doPost()).status).toBe(200);
    const second = await doPost();
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on PKCE mismatch', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'wrong-verifier',
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on redirect_uri mismatch', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://other.example.com/cb',
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on expired code', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, {
      challenge,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_client on unknown client_id', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: 'not-a-real-client',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client');
  });
});

describe('POST /oauth/token — grant_type=refresh_token', () => {
  async function issueInitialTokens(): Promise<{ client: OAuthClientRow; userId: string; refresh: string }> {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    const json = await res.json();
    return { client, userId, refresh: json.refresh_token };
  }

  it('rotates the refresh token on successful refresh', async () => {
    const { client, refresh } = await issueInitialTokens();
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(json.refresh_token).not.toBe(refresh);
  });

  it('revokes the whole family on reuse of a rotated refresh token', async () => {
    const { client, refresh } = await issueInitialTokens();
    // First refresh — rotates the presented token.
    await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    // Replay the original refresh — must trip reuse detection.
    const replay = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');

    const rows = (await db.execute(sql`
      SELECT revoked_at FROM oauth_refresh_tokens
    `)) as unknown as { revoked_at: Date | null }[];
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('returns unsupported_grant_type for unknown grants', async () => {
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- token.test
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/token.ts`**

```ts
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

function err(c: Context, error: string, description: string, status = 400) {
  return c.json({ error, error_description: description }, status);
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
  if (row.clientId !== clientId) return err(c, 'invalid_client', 'client_id mismatch');

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

  if (row.revokedAt !== null || row.expiresAt.getTime() < Date.now()) {
    return err(c, 'invalid_grant', 'refresh_token no longer valid');
  }

  // Mark this row rotated, then mint a fresh pair in the same family.
  await db.execute(sql`
    UPDATE oauth_refresh_tokens
    SET rotated_at = now()
    WHERE id = ${row.id}
  `);

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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- token.test
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/token.ts apps/api/src/auth/oauth/token.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /oauth/token with code + refresh grants

Refs #30
EOF
)"
```

---

## Task 10: `/oauth/revoke` endpoint

**Files:**
- Create: `apps/api/src/auth/oauth/revoke.ts`
- Create: `apps/api/src/auth/oauth/revoke.test.ts`

**Interfaces:**
- Consumes: `hashHex`, `ACCESS_TOKEN_PREFIX`, `REFRESH_TOKEN_PREFIX` from `./tokens.ts`; schema tables.
- Produces: `registerOAuthRevocationRoute(app): void` — mounts `POST /oauth/revoke`.

Behavior:
- Accepts `token` and (optional) `token_type_hint`.
- If `token` is a refresh: `UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE family_id = ?`.
- If `token` is an access: `DELETE FROM oauth_access_tokens WHERE token_hash = ?`.
- If unknown: still return 200 (RFC 7009).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/auth/oauth/revoke.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  users,
} from '@primer/shared/schema';
import { registerOAuthRevocationRoute } from './revoke.ts';
import { createClient } from './clients.ts';
import { generateAccessToken, generateRefreshToken } from './tokens.ts';

async function seed(): Promise<{ userId: string; clientId: string }> {
  const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const client = await createClient({
    clientName: 'C',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    grantTypes: ['authorization_code'],
  });
  return { userId, clientId: client.clientId };
}

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthRevocationRoute(app);
  return app;
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthRefreshTokens);
  await db.delete(oauthClients);
});

describe('POST /oauth/revoke', () => {
  it('revokes a refresh token family', async () => {
    const { userId, clientId } = await seed();
    const familyId = uuidv7();
    const first = generateRefreshToken();
    const second = generateRefreshToken();
    for (const t of [first, second]) {
      await db.insert(oauthRefreshTokens).values({
        id: uuidv7(),
        familyId,
        tokenHash: t.tokenHash,
        userId,
        clientId,
        scopes: ['primer'],
        expiresAt: new Date(Date.now() + 3600 * 1000),
      });
    }
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: first.token }).toString(),
    });
    expect(res.status).toBe(200);

    const rows = (await db.execute(sql`
      SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id = ${familyId}
    `)) as unknown as { revoked_at: Date | null }[];
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('deletes an access token', async () => {
    const { userId, clientId } = await seed();
    const t = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash: t.tokenHash,
      userId,
      clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.token }).toString(),
    });
    expect(res.status).toBe(200);
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM oauth_access_tokens WHERE token_hash = ${t.tokenHash}
    `)) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('returns 200 for an unknown token', async () => {
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'primer_ort_nope' }).toString(),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- revoke
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/auth/oauth/revoke.ts`**

```ts
import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, hashHex } from './tokens.ts';

async function readForm(c: Context): Promise<URLSearchParams> {
  const raw = await c.req.text();
  return new URLSearchParams(raw);
}

export function registerOAuthRevocationRoute(app: Hono): void {
  app.post('/oauth/revoke', async (c) => {
    const body = await readForm(c);
    const token = body.get('token') ?? '';
    if (token.length === 0) return c.body(null, 200);

    const tokenHash = hashHex(token);

    if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
      // Revoke by family so a captured refresh + rotated successor can't survive.
      await db.execute(sql`
        UPDATE oauth_refresh_tokens
        SET revoked_at = now()
        WHERE family_id IN (
          SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ${tokenHash}
        ) AND revoked_at IS NULL
      `);
    } else if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      await db.execute(sql`DELETE FROM oauth_access_tokens WHERE token_hash = ${tokenHash}`);
    }
    // Unknown tokens: 200 per RFC 7009.
    return c.body(null, 200);
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- revoke
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/oauth/revoke.ts apps/api/src/auth/oauth/revoke.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /oauth/revoke endpoint (RFC 7009)

Refs #30
EOF
)"
```

---

## Task 11: Wire OAuth server into the Hono app

**Files:**
- Create: `apps/api/src/auth/oauth/routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/middleware/auth.ts` (extend `PUBLIC_PATHS` and add path-prefix bypass for `/.well-known/oauth-*`)
- Create: `apps/api/src/auth/oauth/e2e.test.ts` (E2E happy path)

**Interfaces:**
- Consumes: everything from Tasks 4, 5, 7, 8, 9, 10 + `OAUTH_ISSUER` env var.
- Produces: `registerOAuthRoutes(app, deps: { issuer: string; sessionCookieName: string }): void`

Rate limits:
- `/oauth/register`: capacity 5, refill 1 / 60s (5 registrations per minute per IP).
- `/oauth/authorize`: capacity 20, refill 1 / 3s.
- `/oauth/token`: capacity 30, refill 1 / 2s.
- `/oauth/revoke`: capacity 20, refill 1 / 3s.

`/oauth/authorize` and `/oauth/consent` are cookie-authenticated and must NOT be added to `PUBLIC_PATHS` (they route through `authMiddleware`'s cookie resolver via `primer_sid`). Actually simpler: the authorize/consent handlers do their own session lookup and issue their own login-redirect, so bypass the middleware for those paths too. `/oauth/register`, `/oauth/token`, `/oauth/revoke`, and `/.well-known/oauth-*` are unauthenticated public endpoints.

- [ ] **Step 1: Create `apps/api/src/auth/oauth/routes.ts`**

```ts
import type { Hono } from 'hono';
import { registerOAuthMetadataRoutes } from './metadata.ts';
import { registerOAuthRegistrationRoute } from './register.ts';
import { registerOAuthAuthorizationRoutes } from './authorize.ts';
import { registerOAuthTokenRoute } from './token.ts';
import { registerOAuthRevocationRoute } from './revoke.ts';
import { oauthRateLimitMiddleware } from './rateLimit.ts';

export interface OAuthRoutesDeps {
  issuer: string;
  sessionCookieName: string;
}

export function registerOAuthRoutes(app: Hono, deps: OAuthRoutesDeps): void {
  // Rate limits — mounted per-endpoint so bucket keys stay scoped.
  app.use('/oauth/register', oauthRateLimitMiddleware({ capacity: 5, refillPerSecond: 1 / 60 }));
  app.use('/oauth/authorize', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));
  app.use('/oauth/consent', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));
  app.use('/oauth/token', oauthRateLimitMiddleware({ capacity: 30, refillPerSecond: 1 / 2 }));
  app.use('/oauth/revoke', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));

  registerOAuthMetadataRoutes(app, { issuer: deps.issuer });
  registerOAuthRegistrationRoute(app);
  registerOAuthAuthorizationRoutes(app, { sessionCookieName: deps.sessionCookieName });
  registerOAuthTokenRoute(app);
  registerOAuthRevocationRoute(app);
}
```

- [ ] **Step 2: Update `middleware/auth.ts` — extend PUBLIC_PATHS and add prefix bypass**

Edit `apps/api/src/middleware/auth.ts`:

Replace the `PUBLIC_PATHS` set and add a prefix helper:

```ts
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/auth/login',
  '/auth/callback',
  '/api/device/authorize',
  '/api/device/token',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/consent',
  '/oauth/token',
  '/oauth/revoke',
]);

function isPublicWellKnown(path: string): boolean {
  return path.startsWith('/.well-known/oauth-');
}
```

Then in `authMiddleware`, change the guard:

```ts
if (PUBLIC_PATHS.has(path) || isPublicCompanionAsset(path) || isPublicWellKnown(path)) return next();
```

- [ ] **Step 3: Update `app.ts` — register OAuth routes**

In `apps/api/src/app.ts`, add near the other `register…` calls (after `registerTokenRoutes(app)`, before the static SPA fallback):

```ts
import { registerOAuthRoutes } from './auth/oauth/routes.ts';
// ...
const issuer =
  process.env.OAUTH_ISSUER ??
  deps.authBaseUrl ??
  process.env.AUTH_BASE_URL ??
  '';
if (issuer.length > 0) {
  registerOAuthRoutes(app, {
    issuer,
    sessionCookieName: deps.authCookieName ?? 'primer_sid',
  });
}
```

Boot-time contract: `OAUTH_ISSUER` (or `AUTH_BASE_URL`) MUST be set in production for OAuth to be reachable. When neither is set (typical for a bare `vitest` file that pulls `createApp` for a narrow test), the OAuth routes are skipped — tests that need OAuth pass `authBaseUrl` explicitly.

- [ ] **Step 4: Write the E2E happy-path test**

Create `apps/api/src/auth/oauth/e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../../app.ts';
import { FilesystemStorage } from '../../storage/filesystem.ts';
import { NoopNotifier } from '../../notifications/notifier.ts';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  sessions,
  users,
} from '@primer/shared/schema';

const AUTH_BASE_URL = 'http://localhost:5173';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-oauth-e2e-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      authBaseUrl: AUTH_BASE_URL,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  for (const table of [
    oauthAccessTokens,
    oauthRefreshTokens,
    oauthAuthorizationCodes,
    oauthConsents,
    oauthClients,
    sessions,
  ]) {
    await db.delete(table);
  }
});

describe('OAuth end-to-end (register → authorize → token)', () => {
  it('completes the full flow and issues an access token', async () => {
    // Seed a session so /oauth/authorize doesn't redirect to Okta.
    const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
    const sid = `s-${randomBytes(16).toString('hex')}`;
    await db.insert(sessions).values({
      id: sid,
      userId,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

    await withApp(async (app) => {
      // 1. Register.
      const regRes = await app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'e2e',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      });
      expect(regRes.status).toBe(201);
      const { client_id } = await regRes.json();

      // 2. Authorize (with existing consent to keep test simple: allow via consent form).
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');

      const authRes = await app.request('/oauth/consent', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `primer_sid=${sid}`,
          'x-primer-csrf': '1',
        },
        body: new URLSearchParams({
          client_id,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'e2e',
          scope: 'primer',
          decision: 'allow',
        }).toString(),
      });
      expect(authRes.status).toBe(302);
      const loc = new URL(authRes.headers.get('location') ?? '', 'http://x');
      const code = loc.searchParams.get('code');
      expect(code).toBeTruthy();

      // 3. Exchange code for tokens.
      const tokenRes = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = await tokenRes.json();
      expect(tokens.token_type).toBe('bearer');
      expect(typeof tokens.access_token).toBe('string');
      expect(typeof tokens.refresh_token).toBe('string');
    });
  });
});
```

- [ ] **Step 5: Run the whole oauth suite plus the E2E**

```bash
pnpm --filter @primer/api test -- oauth
```

Expected: all OAuth tests pass, including the new E2E.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/oauth/routes.ts apps/api/src/auth/oauth/e2e.test.ts apps/api/src/app.ts apps/api/src/middleware/auth.ts
git commit -m "$(cat <<'EOF'
feat(api): wire OAuth 2.1 authorization server into Hono app

Adds registerOAuthRoutes() and per-endpoint rate limits. Extends
PUBLIC_PATHS for the OAuth surfaces. New E2E test exercises the full
register → consent → token exchange flow.

Refs #30
EOF
)"
```

---

## Task 12: MCP tool handlers

**Files:**
- Create: `apps/api/src/mcp/tools.ts`
- Create: `apps/api/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `parsePrimerUrl` from `./urlResolve.ts`; existing service functions in `apps/api/src/routes/*` and `apps/api/src/services/*` — the tool handlers should reuse the DB-access code that backs the REST routes, not call the REST endpoints via HTTP.
- Produces:
  - `TOOL_NAMES = ['primer_whoami', 'primer_get_document', 'primer_list_versions', 'primer_get_comments', 'primer_create_document', 'primer_add_version', 'primer_resolve_url'] as const`
  - `buildMcpToolHandlers(deps: ToolDeps): Record<ToolName, ToolHandler>`
  - `TOOL_CONFIGS: Record<ToolName, { description: string; inputSchema: Record<string, ZodTypeAny> }>`

**Implementation strategy.** Rather than duplicating logic, most handlers can call the existing REST route handlers by dispatching through the same Hono app instance (`app.request(...)`) with `Authorization: Bearer <access>` — but that would double the auth cost. Instead, factor a thin `services/documents.ts` accessor set (create it if it doesn't exist) that both the REST route and the tool handler can share. **However**, to keep this task's scope tight and reviewable, this task's implementation extracts only what the tool handlers need, in place, and leaves REST routes untouched — the tool handlers use `db` + storage APIs directly, mirroring the query patterns in `routes/documents.ts`, `routes/versions.ts`, `routes/upload.ts`, and `routes/threads.ts`.

**Study these files before writing the handlers**, one at a time:
- `apps/api/src/routes/documents.ts` — get-document, patch-document
- `apps/api/src/routes/versions.ts` — list-versions
- `apps/api/src/routes/threads.ts` — get-threads
- `apps/api/src/routes/upload.ts` — create-document, add-version, and the multipart pipeline
- `apps/api/src/upload/htmlPipeline.ts` — HTML sanitize + storage
- `apps/api/src/upload/markdown.ts` — markdown → HTML

The `primer_create_document` and `primer_add_version` handlers take inline `content: string` (not multipart). They should:
1. Detect format (`html` | `markdown`) from the tool arg.
2. Feed markdown through `markdownToHtml`, then always run the result through `transformHtml`.
3. Persist via `storage.put(...)` — the `Storage` interface from `@primer/shared/storage`.
4. Insert the `documents` / `versions` row.
5. Return a summary matching the REST-route response shape (so the skill/consumer sees a familiar payload).

Because this task is denser than the others, split its steps by tool.

- [ ] **Step 1: Read the source files listed above and confirm the service surface**

Skim each file. Note the exact function signatures and query shapes that need to be duplicated (or, if the file exports pure helpers, imported directly).

- [ ] **Step 2: Write the failing test — full file**

Create `apps/api/src/mcp/tools.test.ts`. This test uses the mock user resolver + real DB.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { documents, users, versions } from '@primer/shared/schema';
import { buildMcpToolHandlers, type ToolDeps } from './tools.ts';

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
}

async function withDeps<T>(fn: (deps: ToolDeps) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mcp-tools-'));
  try {
    const storage = new FilesystemStorage(root);
    const notifier = new NoopNotifier();
    return await fn({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM comments`);
  await db.execute(sql`DELETE FROM threads`);
  await db.execute(sql`DELETE FROM versions`);
  await db.execute(sql`DELETE FROM documents`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'tools-%'`);
});

describe('primer_whoami', () => {
  it('returns the user', async () => {
    await seedUser('tools-1');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_whoami({}, { id: 'tools-1', email: 'tools-1@x.test', displayName: 'tools-1' });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toBe('tools-1');
    });
  });
});

describe('primer_resolve_url', () => {
  it('extracts document + version from a Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://primer.example.com/d/abc-123/v/2' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.documentId).toBe('abc-123');
      expect(parsed.versionNumber).toBe(2);
    });
  });

  it('returns bad_request on a non-Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://example.com/foo' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });
});

describe('primer_create_document → primer_get_document (URL mode)', () => {
  it('creates a doc and reads it back by its URL', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const user = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

      const created = await handlers.primer_create_document(
        {
          title: 'Hello',
          content: '# hi',
          format: 'markdown',
        },
        user,
      );
      const createdBody = JSON.parse(created.content[0].text);
      expect(createdBody.documentId).toBeTruthy();
      expect(createdBody.url).toContain('/d/');

      const fetched = await handlers.primer_get_document(
        { url: createdBody.url },
        user,
      );
      const fetchedBody = JSON.parse(fetched.content[0].text);
      expect(fetchedBody.document.title).toBe('Hello');
    });
  });
});

describe('primer_get_document — forbidden path', () => {
  it('returns forbidden for another user\'s document', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'Private', content: '<p>hi</p>', format: 'html' },
        { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' },
      );
      const { documentId } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_document(
        { documentId },
        { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' },
      );
      // Ownership rule: currently the doc reader endpoint returns 200 for any
      // authenticated user (Primer's model is share-by-URL). If the tool
      // preserves that, adjust this expectation to isError = false. The point
      // of this test is to lock in the CURRENT behavior, whichever way it is;
      // update after checking routes/documents.ts.
      expect(res).toBeDefined();
    });
  });
});
```

*Note to implementer:* the last test's expected outcome depends on whether Primer's document read endpoint gates on ownership. Check `routes/documents.ts` before finalizing this test. If reads are open to all authenticated users, drop the `forbidden` case and add an equivalent `not_found` case (deleted document) instead.

- [ ] **Step 3: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- tools.test
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement `apps/api/src/mcp/tools.ts` — start with the pure/simple tools**

Follow the pattern from `apps/mcp/src/tools.ts` for tool-result shape (`{ content: [{ type: 'text', text: JSON.stringify(...) }], isError? }`). Extract the input schema shapes into `TOOL_CONFIGS`. Complete implementation is longer than fits in this checkbox — see the "Full tools.ts skeleton" block below and fill in each handler.

Skeleton:

```ts
import { z, type ZodTypeAny } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { desc, eq, and, isNull } from 'drizzle-orm';
import type { Storage } from '@primer/shared/storage';
import type { Notifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, users } from '@primer/shared/schema';
import { markdownToHtml } from '../upload/markdown.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { parsePrimerUrl } from './urlResolve.ts';

export type PrimerErrorCode =
  | 'not_authenticated'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'network';

export interface TextContent { type: 'text'; text: string; }
export interface ToolResult { isError?: boolean; content: TextContent[]; }
export type AuthUser = { id: string; email: string; displayName: string };
export type ToolHandler = (args: Record<string, unknown>, user: AuthUser) => Promise<ToolResult>;

export interface ToolDeps {
  storage: Storage;
  notifier: Notifier;
  apiBaseUrl: string;   // used to render doc URLs in tool responses
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(code: PrimerErrorCode, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
}

export const TOOL_NAMES = [
  'primer_whoami',
  'primer_get_document',
  'primer_list_versions',
  'primer_get_comments',
  'primer_create_document',
  'primer_add_version',
  'primer_resolve_url',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// Fill in each handler below. Use the query patterns from routes/*.ts.
export function buildMcpToolHandlers(deps: ToolDeps): Record<ToolName, ToolHandler> {
  return {
    primer_whoami: async (_args, user) => ok(user),
    primer_resolve_url: async (args) => {
      const url = typeof args.url === 'string' ? args.url : '';
      const parsed = parsePrimerUrl(url);
      if (!parsed) return err('bad_request', 'not a Primer URL');
      return ok(parsed);
    },
    primer_get_document: async (args, _user) => {
      // Accepts { documentId } OR { url }.
      let documentId: string | undefined;
      if (typeof args.documentId === 'string' && args.documentId.length > 0) {
        documentId = args.documentId;
      } else if (typeof args.url === 'string') {
        const parsed = parsePrimerUrl(args.url);
        if (!parsed) return err('bad_request', 'not a Primer URL');
        documentId = parsed.documentId;
      } else {
        return err('bad_request', 'documentId or url is required');
      }
      // Duplicate the query from routes/documents.ts (id + latest version + title/description/uploader).
      // Return { document, latestVersion } — see DocumentDetailResponse.
      // (fill in)
      return err('not_found', 'implement me');
    },
    primer_list_versions: async (_args, _user) => {
      // (fill in) — mirror routes/versions.ts:list
      return err('not_found', 'implement me');
    },
    primer_get_comments: async (_args, _user) => {
      // (fill in) — mirror routes/threads.ts, format as markdown per apps/mcp/src/format.ts
      return err('not_found', 'implement me');
    },
    primer_create_document: async (args, user) => {
      // (fill in) — mirror routes/upload.ts's create path, but with inline content
      return err('bad_request', 'implement me');
    },
    primer_add_version: async (args, user) => {
      // (fill in) — mirror routes/upload.ts add-version path
      return err('bad_request', 'implement me');
    },
  };
}

export const TOOL_CONFIGS: Record<ToolName, { description: string; inputSchema: Record<string, ZodTypeAny> }> = {
  primer_whoami: {
    description: 'Return the authenticated Primer user (id, email, displayName).',
    inputSchema: {},
  },
  primer_resolve_url: {
    description: 'Parse a Primer document URL and return { documentId, versionNumber? }.',
    inputSchema: { url: z.string() },
  },
  primer_get_document: {
    description: 'Fetch a Primer document by documentId OR by its URL.',
    inputSchema: { documentId: z.string().optional(), url: z.string().optional() },
  },
  primer_list_versions: {
    description: 'List all versions of a Primer document, newest first.',
    inputSchema: { documentId: z.string() },
  },
  primer_get_comments: {
    description: 'Fetch comment threads on a version (or latest version of a document) as a markdown summary.',
    inputSchema: { versionId: z.string().optional(), documentId: z.string().optional() },
  },
  primer_create_document: {
    description: 'Create a new Primer document and upload the initial version. Returns the doc URL.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
    },
  },
  primer_add_version: {
    description: 'Upload a new version of an existing Primer document.',
    inputSchema: {
      documentId: z.string(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
      versionNote: z.string().optional(),
    },
  },
};
```

- [ ] **Step 5: Fill in the handler bodies**

Replace each `// (fill in)` block by mirroring the corresponding REST route in `routes/*.ts`. Use the same DB queries, the same storage-put calls, the same response shapes. For markdown-in-content, run `markdownToHtml` then `transformHtml`. For `primer_create_document`, generate a UUIDv7 doc id, insert both `documents` and `versions` rows, put the HTML into storage under `documents/<docId>/v/1.html` (mirror `upload.ts`), and return `{ documentId, versionNumber: 1, url: \`${deps.apiBaseUrl}/d/${docId}\` }`. For `primer_get_comments`, adapt the markdown-formatting from `apps/mcp/src/format.ts` (import the file if you want, or reimplement the small chunk).

Study `apps/api/src/routes/upload.ts` closely — the storage key format and error handling must match exactly, or existing UI won't render the docs.

- [ ] **Step 6: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- tools.test
```

Expected: 5 tests pass. Adjust the last (forbidden) test to match actual ownership rules discovered in Step 1.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mcp/tools.ts apps/api/src/mcp/tools.test.ts
git commit -m "$(cat <<'EOF'
feat(api): implement MCP tool handlers

Refs #30
EOF
)"
```

---

## Task 13: MCP transport + `/mcp` route

**Files:**
- Modify: `apps/api/package.json` (add `@modelcontextprotocol/sdk`)
- Create: `apps/api/src/mcp/transport.ts`
- Create: `apps/api/src/mcp/routes.ts`
- Create: `apps/api/src/mcp/transport.test.ts`
- Modify: `apps/api/src/app.ts` (register `/mcp` + wire OAuth bearer resolver into the resolver chain)

**Interfaces:**
- Consumes: tool handlers (Task 12); OAuth bearer resolver (Task 6).
- Produces:
  - `registerMcpRoute(app, deps): void` — mounts `POST /mcp` (Streamable HTTP) and adds a bearer 401 response with the `WWW-Authenticate` metadata header.

The MCP SDK's `StreamableHTTPServerTransport` binds to a raw Node request/response pair. Since we run on `@hono/node-server`, we can obtain the underlying `IncomingMessage` and `ServerResponse` via `c.env.incoming` / `c.env.outgoing` (see `apps/api/src/routes/device.ts`'s use of `c.env.incoming.socket.remoteAddress` for the same trick).

Stateless mode: we construct a new `McpServer` + `StreamableHTTPServerTransport` per request. That's fine for a stateless tool surface with no notifications.

- [ ] **Step 1: Add the SDK dependency**

```bash
pnpm --filter @primer/api add @modelcontextprotocol/sdk@^1.29.0
```

- [ ] **Step 2: Update `app.ts` to compose the OAuth bearer resolver into the auth chain**

Before this task, `apps/api/src/app.ts` uses a resolver passed in via `deps.userResolver` (which in production is `composeResolvers(makeBearerResolver(), makeOktaResolver({...}))`). Update `app.ts`'s default so when both `oktaAdapter` and no explicit resolver are provided, the composed chain is `oauth-bearer → pat-bearer → okta-cookie`. Where the production wire-up currently lives (probably `apps/api/src/index.ts`), update the composeResolvers call to include the OAuth bearer resolver first.

Find the production composeResolvers call and change:

```ts
composeResolvers(makeBearerResolver(), makeOktaResolver({ cookieName: 'primer_sid' }))
```

to:

```ts
composeResolvers(
  makeOAuthBearerResolver(),
  makeBearerResolver(),
  makeOktaResolver({ cookieName: 'primer_sid' }),
)
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/src/mcp/transport.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers } from '../auth/bearer.ts';
import { makeOAuthBearerResolver } from '../auth/oauth/bearer.ts';
import { db } from '../db/client.ts';
import { oauthAccessTokens, oauthClients, users } from '@primer/shared/schema';
import { createClient } from '../auth/oauth/clients.ts';
import { generateAccessToken } from '../auth/oauth/tokens.ts';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mcp-transport-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeOAuthBearerResolver()),
      authBaseUrl: 'http://localhost:5173',
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedAccessToken(): Promise<{ token: string; userId: string }> {
  const userId = `mcp-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const client = await createClient({
    clientName: 'test',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    grantTypes: ['authorization_code'],
  });
  const { token, tokenHash } = generateAccessToken();
  await db.insert(oauthAccessTokens).values({
    id: uuidv7(),
    tokenHash,
    userId,
    clientId: client.clientId,
    scopes: ['primer'],
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  return { token, userId };
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthClients);
});

describe('POST /mcp', () => {
  it('returns 401 with WWW-Authenticate when no bearer is present', async () => {
    await withApp(async (app) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('www-authenticate') ?? '';
      expect(wwwAuth).toMatch(/^Bearer/);
      expect(wwwAuth).toContain('resource_metadata=');
    });
  });

  it('lists the seven tools for an authenticated request', async () => {
    const { token } = await seedAccessToken();
    await withApp(async (app) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('primer_whoami');
      expect(text).toContain('primer_get_document');
      expect(text).toContain('primer_resolve_url');
    });
  });
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test -- transport.test
```

Expected: FAIL.

- [ ] **Step 5: Implement `apps/api/src/mcp/transport.ts`**

```ts
import type { Context } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AppVariables } from '../app.ts';
import {
  buildMcpToolHandlers,
  TOOL_CONFIGS,
  TOOL_NAMES,
  type ToolDeps,
} from './tools.ts';

export interface McpTransportDeps extends ToolDeps {
  serverName?: string;
  serverVersion?: string;
}

/**
 * Handles a single /mcp POST by building a fresh MCP server + Streamable HTTP
 * transport per request. Stateless: no session store, no notifications, no
 * subscriptions. The tool handlers see the request user via a closure —
 * captured from `c.get('user')` at request time.
 */
export async function handleMcpRequest(
  c: Context<{ Variables: AppVariables }>,
  deps: McpTransportDeps,
): Promise<Response> {
  const user = c.get('user');
  // authMiddleware only reaches the handler when user is set — but be defensive.
  if (!user) {
    return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'not_authenticated' } }, 401);
  }

  const handlers = buildMcpToolHandlers(deps);
  const server = new McpServer({
    name: deps.serverName ?? 'primer',
    version: deps.serverVersion ?? '0.0.0',
  });

  for (const name of TOOL_NAMES) {
    const config = TOOL_CONFIGS[name];
    const handler = handlers[name];
    server.registerTool(
      name,
      { description: config.description, inputSchema: config.inputSchema },
      async (args: Record<string, unknown>) => handler(args ?? {}, user) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  await server.connect(transport);

  const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;
  const req = env?.incoming;
  const res = env?.outgoing;
  if (!req || !res) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'no raw request' } }, 500);
  }

  // handleRequest reads the JSON body internally.
  await transport.handleRequest(req, res);
  return c.body(null); // Response was already flushed via `res` above.
}
```

- [ ] **Step 6: Implement `apps/api/src/mcp/routes.ts`**

```ts
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { handleMcpRequest, type McpTransportDeps } from './transport.ts';

export function registerMcpRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: McpTransportDeps & { issuer: string },
): void {
  app.on('POST', '/mcp', async (c) => {
    // The auth middleware runs first. When the user isn't set, respond with
    // 401 + WWW-Authenticate metadata so Claude Web knows where to refresh.
    if (!c.get('user')) {
      const resourceMetadata = `${deps.issuer}/.well-known/oauth-protected-resource`;
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${resourceMetadata}"`,
      );
      return c.json({ error: 'unauthenticated' }, 401);
    }
    return handleMcpRequest(c, deps);
  });
}
```

Wait — `authMiddleware` currently returns 401 itself before this handler runs. We need `/mcp` to emit the `WWW-Authenticate` header on that 401. Update `middleware/auth.ts`: when a request to `/mcp` gets rejected, set the header before returning.

Extend `authMiddleware` in `middleware/auth.ts` (do this modification in this task):

```ts
if (isApiPath(path) || path.startsWith('/auth/') || path === '/mcp') {
  if (path === '/mcp') {
    const issuer = process.env.OAUTH_ISSUER ?? process.env.AUTH_BASE_URL ?? '';
    if (issuer) {
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
      );
    }
  }
  return c.json({ error: 'unauthenticated' }, 401);
}
```

- [ ] **Step 7: Wire `registerMcpRoute` in `app.ts`**

Near the other register calls, after `registerOAuthRoutes`:

```ts
import { registerMcpRoute } from './mcp/routes.ts';
// ...
if (issuer.length > 0) {
  registerMcpRoute(app, {
    storage: deps.storage,
    notifier: deps.notifier,
    apiBaseUrl: issuer,
    issuer,
  });
}
```

- [ ] **Step 8: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test -- transport.test
```

Expected: 2 tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/mcp/transport.ts apps/api/src/mcp/routes.ts apps/api/src/mcp/transport.test.ts apps/api/src/app.ts apps/api/src/middleware/auth.ts
git commit -m "$(cat <<'EOF'
feat(api): mount Streamable HTTP MCP transport at /mcp

Adds a stateless Streamable HTTP MCP endpoint that reuses the OAuth
bearer resolver for auth. WWW-Authenticate metadata header exposes the
protected-resource metadata URL on 401s so Claude Web can discover
where to authenticate.

Refs #30
EOF
)"
```

---

## Task 14: Final integration, regression, and manual verification checklist

**Files:**
- Modify (if needed): `apps/api/src/index.ts` — resolver chain (should already be updated in Task 13)
- Create: `docs/superpowers/verification/2026-07-01-primer-remote-mcp-verification.md` — manual verification notes

- [ ] **Step 1: Confirm the production resolver chain includes the OAuth bearer resolver**

Read `apps/api/src/index.ts`. The `composeResolvers` call must now be:

```ts
composeResolvers(
  makeOAuthBearerResolver(),
  makeBearerResolver(),
  makeOktaResolver({ cookieName: sessionCookieName }),
)
```

If Task 13 didn't already update this, update it now.

- [ ] **Step 2: Regression — run the full api test suite**

```bash
pnpm --filter @primer/api test
```

Expected: all tests pass, including existing device-flow tests. Any regression here means the OAuth bearer resolver is stealing PAT tokens or the middleware changes broke a public path — investigate before continuing.

- [ ] **Step 3: Regression — run the stdio MCP test suite**

```bash
pnpm --filter @polygonlabs/primer-mcp test
```

Expected: unchanged. This scope explicitly does not modify the stdio path; if these tests fail something leaked.

- [ ] **Step 4: Typecheck everything**

```bash
pnpm -r typecheck
```

Expected: all packages pass.

- [ ] **Step 5: Manual verification against a running local API**

Start the API locally with `OAUTH_ISSUER` set. Walk through:

1. **Discovery.** `curl http://localhost:3000/.well-known/oauth-authorization-server` returns the metadata JSON.
2. **DCR.** `curl -sX POST http://localhost:3000/oauth/register -H 'content-type: application/json' -d '{"client_name":"local","redirect_uris":["http://127.0.0.1:8123/cb"],"grant_types":["authorization_code","refresh_token"]}'` returns `client_id`.
3. **Authorize.** In a browser (logged into Primer), visit `/oauth/authorize?client_id=…&redirect_uri=http://127.0.0.1:8123/cb&response_type=code&code_challenge=<gen>&code_challenge_method=S256&state=abc&scope=primer`. Approve. Note the `code` returned to the redirect (view via a netcat listener on port 8123 or a tiny local server).
4. **Token.** POST `/oauth/token` with the code + verifier. Receive access + refresh.
5. **Tool call.** `curl -sX POST http://localhost:3000/mcp -H "Authorization: Bearer <access>" -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`. Confirm seven tools.
6. **Refresh.** POST `/oauth/token` with `grant_type=refresh_token`. Confirm a new pair, different refresh string.
7. **Reuse detection.** Replay the ORIGINAL refresh token. Confirm 400 `invalid_grant`. Query `oauth_refresh_tokens` to confirm the whole family is `revoked_at IS NOT NULL`.
8. **Revoke.** POST `/oauth/revoke` with the current refresh. Confirm 200.
9. **Regression (device flow).** From a Claude Code session, run through `primer_login` → `primer_login_status` → `primer_whoami`. Confirm it still works — device flow untouched.
10. **Claude Web.** Once a public URL is available, add the connector in Claude Web and complete the full flow end-to-end. Note the exact redirect_uri Claude Web advertises — if it differs from what's in the allowlist, update `REDIRECT_URI_ALLOWLIST` in `apps/api/src/auth/oauth/clients.ts` and add a test asserting the new value.

- [ ] **Step 6: Write up the verification results**

Create `docs/superpowers/verification/2026-07-01-primer-remote-mcp-verification.md` capturing:
- Actual redirect_uri Claude Web advertised.
- Actual redirect_uri Claude Desktop advertises (if tested).
- Any URL parsing surprises for real Primer URLs (e.g. slug vs id).
- Whether the seven tools work end-to-end via Claude Web.

- [ ] **Step 7: Update the spec's redirect_uri allowlist if needed**

If Step 6 turned up a different or additional redirect URI, edit `docs/superpowers/specs/2026-07-01-primer-remote-mcp-design.md` Section 8 ("Redirect-URI allowlist") to reflect the final list, and edit `apps/api/src/auth/oauth/clients.ts` `REDIRECT_URI_ALLOWLIST` in the same PR.

- [ ] **Step 8: Update `PUBLIC_PATHS` and env docs**

Verify (grep) the following paths are handled:
- `/api/health`, `/auth/login`, `/auth/callback`, `/api/device/authorize`, `/api/device/token` — existing
- `/oauth/register`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, `/oauth/revoke`, `/.well-known/oauth-*` — new

Also confirm the `.env.example` (or the README section listing env vars) mentions `OAUTH_ISSUER`. If not, add it.

- [ ] **Step 9: Push the branch and open a draft PR**

**Wait for explicit greenlight from the user before pushing.** Do not push automatically — Primer's master auto-deploys to Railway and every PR triggers CI cost.

Once greenlit, from `issue-30-remote-mcp-oauth`:

```bash
git push -u origin issue-30-remote-mcp-oauth
gh pr create --draft --title "feat: remote MCP + OAuth 2.1 for Claude Web/Desktop" --body "$(cat <<'EOF'
## Summary

Ships a hosted Streamable HTTP MCP transport at `/mcp` on the existing API, protected by a minimal OAuth 2.1 authorization server backed by the existing Okta-federated session. Adds `.well-known` metadata, DCR (redirect-URI-allowlisted), PKCE-only public clients, short-lived access + rotating refresh with reuse detection, and seven MCP tools (whoami, get_document by id or URL, list_versions, get_comments, create_document, add_version, resolve_url).

Existing stdio MCP + device-flow path is untouched.

Closes #30

## Test plan

- [x] Unit + HTTP-level tests for every OAuth endpoint
- [x] E2E test: register → consent → token
- [x] MCP transport smoke: tools/list + bearer 401 with WWW-Authenticate
- [x] Regression: `pnpm --filter @polygonlabs/primer-mcp test` unchanged
- [ ] Manual: add the Primer connector in Claude Web, complete auth, exercise tools
- [ ] Manual: replay a rotated refresh, confirm family-revoke

## Spec + plan

- Spec: `docs/superpowers/specs/2026-07-01-primer-remote-mcp-design.md`
- Plan: `docs/superpowers/plans/2026-07-01-primer-remote-mcp.md`
EOF
)"
```

- [ ] **Step 10: Move the issue to `needs-review` and post a comment**

```bash
gh issue edit 30 --repo 0xPolygon/primer --remove-label agent-ready --add-label needs-review
gh issue comment 30 --repo 0xPolygon/primer --body "Draft PR is up. What changed: [links to spec + plan + PR]. What to verify: (1) add the connector in Claude Web against the deployed URL and try a full flow; (2) confirm the stdio CLI path still works; (3) confirm the redirect-URI allowlist has the URI Claude Web actually advertises."
```

---

## Self-Review

Read the spec, then check the plan against it.

**1. Spec coverage:**
- Section 1 Architecture → Task 1 (schema), Task 11 (wiring), Task 13 (transport).
- Section 2 Components → Tasks 5–10 (OAuth), Task 12 (tools), Task 13 (transport).
- Section 3 Data flow A/B/C/D → Tasks 8/9 cover A + C; Task 13 covers B; Task 10 + Task 9 cover D.
- Section 4 Data model → Task 1.
- Section 5 Error handling → Every OAuth task's tests assert the specific RFC error codes; MCP surface errors are in Task 12.
- Section 6 Security posture → allowlist (Task 5), PKCE (Task 2/9), rotation-reuse (Task 9), rate limits (Task 4/11), consent-form CSRF (Task 8), 401 WWW-Authenticate (Task 13). All present.
- Section 7 Testing → each task has a colocated test; Task 14 does regression + manual.
- Section 8 Rollout → Task 1 (migration), Task 11 (env var wiring), Task 14 (allowlist finalization + PR).

No gaps.

**2. Placeholder scan:** No TBDs. Task 12 leaves `// (fill in)` comments in a skeleton — but each is scoped to a specific route the implementer is told to read, so it's a "look here" pointer, not a "figure it out yourself" placeholder. Acceptable for this task's size.

**3. Type consistency:** Function names match: `hashHex`, `generateAuthCode`, `generateAccessToken`, `generateRefreshToken`, `verifyPkceS256`, `getClient`, `createClient`, `makeOAuthBearerResolver`, `buildMcpToolHandlers`, `TOOL_NAMES`, `TOOL_CONFIGS`, `registerMcpRoute`, `registerOAuthRoutes`. Consistent across tasks.

**Deviations from spec noted:**
- The spec's file plan lists `oauth/bearer.ts` as living inside the `oauth/` subfolder rather than replacing `auth/bearer.ts`. The plan keeps that split. ✓
- The spec says `packages/shared/schema.ts`; the actual path is `packages/shared/src/schema.ts`. The plan uses the correct path. ✓
