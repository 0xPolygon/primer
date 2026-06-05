# Primer API + MCP + Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CLI agent publish to Primer: create a document, upload new versions as it iterates, and fetch a version's comments for feedback. Delivered as three layers — (A) personal-access-token machine auth on the existing API, (B) a `@primer/mcp` stdio server, (C) a `primer` Claude Code skill.

**Architecture:** A bearer resolver is composed ahead of the existing okta/mock resolver so a `primer_pat_…` token resolves to its owner; CSRF exempts bearer-authed requests. New `/api/tokens` routes (+ a small web UI) mint/list/revoke tokens. The MCP server wraps the existing REST API with a Bearer header and exposes create/add-version/get-comments tools over stdio. The skill orchestrates those tools. No existing route handler changes behavior.

**Tech Stack:** Hono (Node 24) + Drizzle + postgres on the API; React 19 + Vite + Tailwind 4 on the web; new `apps/mcp` package on `@modelcontextprotocol/sdk` + `zod`. TypeScript everywhere, Vitest (node env, pure-logic + mocked-fetch tests — no JSDOM).

**Spec:** `docs/superpowers/specs/2026-06-05-primer-api-mcp-agent-design.md`

**Important constraints from project memory:**
- Use `pnpm`, not `npm`. Node 24 LTS.
- Never `git push` without explicit instruction in the turn — `master` auto-deploys to Railway. Every task ends with a commit; pushing is the user's call. (This plan targets the feature branch `claude/primer-api-mcp-agent-xzkzl`.)
- Don't skip git hooks (`--no-verify`) or signing.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge: 14 days`, `allowBuilds: { esbuild: true }`, `blockExoticSubdeps`, `strictPeerDependencies`. New deps must clear the 14-day gate and ship no postinstall scripts. If `pnpm` prompts to approve a build script, **stop and ask** — never approve sight-unseen.
- NixOS dev box: ensure both `pnpm` and the Nix-store `node` are on `PATH` before `pnpm install`.
- Migrations are generated with `pnpm db:generate` after editing `packages/shared/src/schema.ts`, then the SQL is committed. Apply with `pnpm db:migrate` / `pnpm db:migrate:test`.

---

## File map

**Sub-project A — API tokens (machine auth)**

New (shared/API):
- `apps/api/src/auth/tokens.ts` — token generate/hash/parse helpers.
- `apps/api/src/auth/tokens.test.ts`
- `apps/api/src/auth/bearer.ts` — `makeBearerResolver`, `composeResolvers`.
- `apps/api/src/auth/bearer.test.ts`
- `apps/api/src/routes/tokens.ts` — `POST/GET/DELETE /api/tokens`.
- `apps/api/src/routes/tokens.test.ts`
- `apps/api/drizzle/0005_*.sql` — generated migration for `api_tokens`.

Modified (shared/API):
- `packages/shared/src/schema.ts` — `apiTokens` table.
- `packages/shared/src/api.ts` — token DTOs.
- `apps/api/src/app.ts` — `AppVariables.authMethod`; register token routes.
- `apps/api/src/auth/resolver.ts` — set `authMethod` in mock/okta resolvers.
- `apps/api/src/middleware/auth.ts` — (only if needed) keep public-path logic intact.
- `apps/api/src/auth/csrf.ts` — exempt `authMethod === 'bearer'`.
- `apps/api/src/index.ts` — compose bearer resolver in both auth modes.
- `apps/api/src/jobs/purge.ts` (+ `.test.ts`) — `purgeExpiredTokens`.

New/Modified (web):
- `apps/web/src/queries/tokens.ts` — list/create/revoke queries.
- `apps/web/src/routes/settings-tokens.tsx` — token management page.
- route registration + a nav entry (wherever routes/AppShell live).

**Sub-project B — `@primer/mcp` stdio server**

New (`apps/mcp/`):
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs` (mirror `apps/api`).
- `src/client.ts` + `src/client.test.ts`
- `src/format.ts` + `src/format.test.ts`
- `src/tools.ts` + `src/tools.test.ts`
- `src/index.ts`
- `README.md`

**Sub-project C — `primer` skill**

New:
- `.claude/skills/primer/SKILL.md`
- `.claude/skills/primer/reference.md`

---

# Sub-project A — API tokens

### Task A1: `apiTokens` schema + migration

**Files:** Modify `packages/shared/src/schema.ts`; create `apps/api/drizzle/0005_*.sql` (generated).

- [ ] **Step 1: Append the table to `schema.ts`**

`uniqueIndex` and `index` are already imported. Add after the `sessions` table:

```ts
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('api_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('api_tokens_user_id_idx').on(t.userId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

```
pnpm db:generate
```

Expected: a new `apps/api/drizzle/0005_*.sql` creating `api_tokens` + indexes, and updated `drizzle/meta`. Review the SQL.

- [ ] **Step 3: Apply locally (dev + test DBs)**

```
pnpm db:up
pnpm db:migrate
pnpm db:migrate:test
```

- [ ] **Step 4: Typecheck**

```
pnpm typecheck
```

- [ ] **Step 5: Commit**

```
git add packages/shared/src/schema.ts apps/api/drizzle/
git commit -m "feat(shared): api_tokens table + migration"
```

---

### Task A2: Token helpers (TDD)

**Files:** Create `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/tokens.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, TOKEN_PREFIX } from './tokens.ts';

describe('token helpers', () => {
  it('generates a prefixed, high-entropy token + matching prefix/hash', () => {
    const t = generateToken();
    expect(t.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t.token.length).toBeGreaterThan(TOKEN_PREFIX.length + 40);
    expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.tokenHash).toBe(hashToken(t.token));
    expect(t.tokenPrefix).toHaveLength(8);
    expect(t.token).toContain(t.tokenPrefix);
  });

  it('produces distinct tokens', () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });

  it('hashToken is stable and hex', () => {
    expect(hashToken('primer_pat_abc')).toBe(hashToken('primer_pat_abc'));
    expect(hashToken('primer_pat_abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Verify they fail** (`cd apps/api && pnpm test -- tokens.test`).

- [ ] **Step 3: Implement `tokens.ts`**

```ts
import { randomBytes, createHash } from 'node:crypto';

export const TOKEN_PREFIX = 'primer_pat_';

export interface GeneratedToken {
  token: string;       // plaintext, returned once
  tokenHash: string;   // sha-256 hex of the full token
  tokenPrefix: string; // first 8 chars of the random part (for display)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): GeneratedToken {
  const random = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashToken(token), tokenPrefix: random.slice(0, 8) };
}
```

- [ ] **Step 4: Re-run tests** (PASS), then commit:

```
git add apps/api/src/auth/tokens.ts apps/api/src/auth/tokens.test.ts
git commit -m "feat(api): personal-access-token generate/hash helpers"
```

---

### Task A3: Bearer resolver + compose (TDD)

**Files:** Create `apps/api/src/auth/bearer.ts`, `apps/api/src/auth/bearer.test.ts`. Modify `packages/shared` not needed.

This task also adds `authMethod` to `AppVariables` (Task A4 wires CSRF off it). Add the type here so the resolver compiles.

- [ ] **Step 1: Add `authMethod` to `AppVariables`** in `apps/api/src/app.ts`:

```ts
export type AppVariables = {
  user: { id: string; email: string; displayName: string };
  authMethod?: 'bearer' | 'cookie' | 'mock';
};
```

- [ ] **Step 2: Write failing tests for `bearer.ts`**

Use a real (test) DB row. Mirror existing DB-touching tests (they run against `primer_test`). Insert a user + token, then assert resolution. Sketch:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { makeBearerResolver, composeResolvers } from './bearer.ts';
import { generateToken } from './tokens.ts';
import { db } from '../db/client.ts';
import { users, apiTokens } from '@primer/shared/schema';
import { v7 as uuidv7 } from 'uuid';

function ctxWithAuth(header: string | undefined) {
  const store = new Map<string, unknown>();
  return {
    req: { header: (k: string) => (k.toLowerCase() === 'authorization' ? header : undefined) },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    _store: store,
  } as any;
}

describe('makeBearerResolver', () => {
  const resolver = makeBearerResolver();

  it('returns null when no Authorization header', async () => {
    expect(await resolver(ctxWithAuth(undefined))).toBeNull();
  });

  it('returns null for a non-primer bearer', async () => {
    expect(await resolver(ctxWithAuth('Bearer abc'))).toBeNull();
  });

  it('resolves a valid token to its user and sets authMethod', async () => {
    const uid = 'bearer-user-1';
    await db.insert(users).values({ id: uid, email: `${uid}@polygon.technology`, displayName: 'Bearer User' }).onConflictDoNothing();
    const t = generateToken();
    await db.insert(apiTokens).values({ id: uuidv7(), userId: uid, name: 'test', tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix });
    const c = ctxWithAuth(`Bearer ${t.token}`);
    const u = await resolver(c);
    expect(u?.id).toBe(uid);
    expect(c.get('authMethod')).toBe('bearer');
  });

  it('returns null for a revoked token', async () => {
    const uid = 'bearer-user-2';
    await db.insert(users).values({ id: uid, email: `${uid}@polygon.technology`, displayName: 'B2' }).onConflictDoNothing();
    const t = generateToken();
    await db.insert(apiTokens).values({ id: uuidv7(), userId: uid, name: 'r', tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix, revokedAt: new Date() });
    expect(await resolver(ctxWithAuth(`Bearer ${t.token}`))).toBeNull();
  });
});

describe('composeResolvers', () => {
  it('returns the first non-null result', async () => {
    const a = async () => null;
    const b = async () => ({ id: 'x', email: 'x', displayName: 'x' });
    expect((await composeResolvers(a, b)(ctxWithAuth(undefined)))?.id).toBe('x');
  });
});
```

(Adapt the context stub to whatever the existing resolver tests use; `resolver.test.ts` is the reference.)

- [ ] **Step 3: Verify failure** (`cd apps/api && pnpm test -- bearer.test`).

- [ ] **Step 4: Implement `bearer.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { UserResolver } from './resolver.ts';
import { db } from '../db/client.ts';
import { hashToken, TOKEN_PREFIX } from './tokens.ts';

const TOUCH_THRESHOLD_MS = 60 * 1000;

export function makeBearerResolver(): UserResolver {
  return async (c) => {
    const header = c.req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token.startsWith(TOKEN_PREFIX)) return null;

    const tokenHash = hashToken(token);
    const [row] = (await db.execute(sql`
      SELECT u.id AS u_id, u.email AS u_email, u.display_name AS u_display_name,
             t.id AS t_id, t.last_used_at AS t_last_used
      FROM api_tokens t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
      LIMIT 1
    `)) as unknown as Array<{ u_id: string; u_email: string; u_display_name: string; t_id: string; t_last_used: Date | string | null }>;
    if (!row) return null;

    const last = row.t_last_used ? new Date(row.t_last_used).getTime() : 0;
    if (Date.now() - last > TOUCH_THRESHOLD_MS) {
      void db.execute(sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${row.t_id}`).catch(() => undefined);
    }

    c.set('authMethod', 'bearer');
    return { id: row.u_id, email: row.u_email, displayName: row.u_display_name };
  };
}

export function composeResolvers(...resolvers: UserResolver[]): UserResolver {
  return async (c) => {
    for (const r of resolvers) {
      const u = await r(c);
      if (u) return u;
    }
    return null;
  };
}
```

- [ ] **Step 5: Set `authMethod` in the other resolvers** in `apps/api/src/auth/resolver.ts`: `mockResolver`/`mockMultiResolver` set `c.set('authMethod','mock')`; `makeOktaResolver` sets `c.set('authMethod','cookie')` on success. (Small additions; keep return values identical.)

- [ ] **Step 6: Re-run tests + typecheck** (PASS). Commit:

```
git add apps/api/src/auth/bearer.ts apps/api/src/auth/bearer.test.ts apps/api/src/auth/resolver.ts apps/api/src/app.ts
git commit -m "feat(api): bearer token resolver + resolver composition"
```

---

### Task A4: CSRF bearer exemption (TDD)

**Files:** Modify `apps/api/src/auth/csrf.ts`, `apps/api/src/auth/csrf.test.ts`.

- [ ] **Step 1: Add a failing test** — a mutating request whose context has `authMethod==='bearer'` passes CSRF without the header; a cookie/mock request without the header still 403s. (Follow the existing `csrf.test.ts` harness; it may build a tiny Hono app — set the var via a preceding middleware in the test.)

- [ ] **Step 2: Implement** — in `csrfMiddleware`, after the method guard, before the header check:

```ts
  if (c.get('authMethod') === 'bearer') return next();
```

(`csrfMiddleware` currently has no generic type; type it `MiddlewareHandler<{ Variables: AppVariables }>` so `c.get` is available, importing the type.)

- [ ] **Step 3: Run tests + typecheck** (PASS). Commit:

```
git add apps/api/src/auth/csrf.ts apps/api/src/auth/csrf.test.ts
git commit -m "feat(api): exempt bearer-authenticated requests from CSRF"
```

---

### Task A5: Token DTOs + routes (TDD)

**Files:** Modify `packages/shared/src/api.ts`; create `apps/api/src/routes/tokens.ts`, `apps/api/src/routes/tokens.test.ts`; modify `apps/api/src/app.ts`.

- [ ] **Step 1: Append DTOs to `packages/shared/src/api.ts`** (see spec Section 3): `ApiTokenSummary`, `CreateTokenRequest`, `CreateTokenResponse`, `ApiTokensListResponse`.

- [ ] **Step 2: Write failing route tests** using the existing harness (`asUser`, `asUserJson`, `CSRF_HEADERS`). Cover:
  - `POST /api/tokens` with `{ name }` → 201, body includes a `token` starting `primer_pat_`, and `tokenPrefix`.
  - `GET /api/tokens` → lists the created token, **no `token` field**, correct `tokenPrefix`.
  - The minted token actually authenticates: `app.request('/api/me', { headers: { authorization: 'Bearer ' + token } })` → 200 with the owner. (Requires the app to be built with a bearer-composed resolver — pass `userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver)` in the test.)
  - `DELETE /api/tokens/:id` by owner → 200; the token no longer authenticates (`/api/me` → 401).
  - `DELETE` of another user's token → 404 (use `asUser('other')`).
  - `POST /api/tokens` with missing/blank `name` → 400.
  - `expiresInDays` sets `expiresAt`; an already-expired token (insert directly with past `expiresAt`) → does not authenticate.

- [ ] **Step 3: Verify failure**, then implement `apps/api/src/routes/tokens.ts`:

```ts
import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { ApiTokenSummary, ApiTokensListResponse, CreateTokenResponse } from '@primer/shared';
import { apiTokens } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import { generateToken } from '../auth/tokens.ts';

const MAX_NAME = 100;

function toSummary(r: typeof apiTokens.$inferSelect): ApiTokenSummary {
  return {
    id: r.id, name: r.name, tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

export function registerTokenRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.post('/api/tokens', async (c) => {
    const user = c.get('user');
    let payload: { name?: unknown; expiresInDays?: unknown };
    try { payload = await c.req.json(); } catch { return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400); }
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME) return c.json({ error: 'invalid_body', message: `name must be 1–${MAX_NAME} chars` }, 400);

    let expiresAt: Date | null = null;
    if (payload.expiresInDays !== undefined) {
      const d = Number(payload.expiresInDays);
      if (!Number.isFinite(d) || d <= 0 || d > 365) return c.json({ error: 'invalid_body', message: 'expiresInDays must be 1–365' }, 400);
      expiresAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
    }

    const gen = generateToken();
    const id = uuidv7();
    await db.insert(apiTokens).values({ id, userId: user.id, name, tokenHash: gen.tokenHash, tokenPrefix: gen.tokenPrefix, expiresAt });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    const body: CreateTokenResponse = { ...toSummary(row), token: gen.token };
    return c.json(body, 201);
  });

  app.get('/api/tokens', async (c) => {
    const user = c.get('user');
    const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, user.id)).orderBy(desc(apiTokens.createdAt));
    const body: ApiTokensListResponse = { tokens: rows.map(toSummary) };
    return c.json(body, 200);
  });

  app.delete('/api/tokens/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const [existing] = await db.select().from(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id)));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.revokedAt === null) {
      await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
    }
    return c.json({ id, revokedAt: (existing.revokedAt ?? new Date()).toISOString() }, 200);
  });
}
```

- [ ] **Step 4: Register the routes** in `apps/api/src/app.ts` (`import { registerTokenRoutes }` and call it alongside the others).

- [ ] **Step 5: Run tests + typecheck** (PASS). Commit:

```
git add packages/shared/src/api.ts apps/api/src/routes/tokens.ts apps/api/src/routes/tokens.test.ts apps/api/src/app.ts
git commit -m "feat(api): token management routes (mint/list/revoke)"
```

---

### Task A6: Compose bearer resolver at boot + purge expired tokens

**Files:** Modify `apps/api/src/index.ts`, `apps/api/src/jobs/purge.ts` (+ `.test.ts`).

- [ ] **Step 1: Wrap the chosen resolver with bearer** in `index.ts`. Where it currently sets `userResolver = makeOktaResolver(...)` / `mockResolver`, wrap:

```ts
import { makeBearerResolver, composeResolvers } from './auth/bearer.ts';
// …after picking `base` (okta or mock):
userResolver = composeResolvers(makeBearerResolver(), base);
```

Bearer works in **both** modes (so the MCP is testable locally under `AUTH_MODE=mock`; absent a token it falls back to mock).

- [ ] **Step 2: Add `purgeExpiredTokens`** to `purge.ts` and call it from the same interval tick. `DELETE FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days'`. Add a test mirroring the existing purge tests (insert an old revoked token, run, assert gone; a recently-revoked one survives).

- [ ] **Step 3: Run full suite + typecheck**

```
pnpm typecheck && pnpm test
```

- [ ] **Step 4: Manual smoke (mock mode)**

```
pnpm dev
# mint a token (mock user), then:
curl -s localhost:3000/api/tokens -X POST -H 'content-type: application/json' -H 'x-primer-csrf: 1' -d '{"name":"smoke"}'
# copy the .token, then:
curl -s localhost:3000/api/me -H "authorization: Bearer primer_pat_…"
```

Expected: `/api/me` returns `mock-user-1` via the bearer path (no CSRF header needed for a future POST with that bearer).

- [ ] **Step 5: Commit**

```
git add apps/api/src/index.ts apps/api/src/jobs/purge.ts apps/api/src/jobs/purge.test.ts
git commit -m "feat(api): enable bearer auth at boot + purge stale tokens"
```

---

### Task A7: Web UI — API tokens settings page

**Files:** Create `apps/web/src/queries/tokens.ts`, `apps/web/src/routes/settings-tokens.tsx`; wire the route + a nav link (read the existing router/AppShell first to match patterns — see how `me.ts` query and existing routes are structured).

- [ ] **Step 1: Add queries** (`useApiTokens`, `useCreateToken`, `useRevokeToken`) using the existing `api()` fetch wrapper (`apps/web/src/lib/fetch.ts`) so the CSRF header + 401 handling come for free.
- [ ] **Step 2: Build the page** — list tokens (name, `tokenPrefix…`, created, last used, expiry, revoked state); a "Create token" form (name + optional expiry); on create, show the **plaintext token once** in a copy-to-clipboard panel with a clear "you won't see this again" warning (reuse `clipboardCopy.ts`); a revoke button per active token (confirm).
- [ ] **Step 3: Register the route** and add an entry point (e.g. under the user menu in `AppShell.tsx`).
- [ ] **Step 4: Typecheck + test + manual check** (`pnpm dev` → mint/copy/revoke round-trip).
- [ ] **Step 5: Commit**

```
git add apps/web/src/queries/tokens.ts apps/web/src/routes/settings-tokens.tsx apps/web/src/AppShell.tsx
git commit -m "feat(web): API token management settings page"
```

- [ ] **Step 6: Docs** — update `.env.example` comments if needed (no new server env for SP-A) and add a short "Programmatic access / API tokens" section to `README.md`. Commit.

---

# Sub-project B — `@primer/mcp` stdio server

### Task B1: Scaffold `apps/mcp`

**Files:** Create `apps/mcp/package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`.

- [ ] **Step 1: `package.json`** — mirror `apps/api`'s module/test setup:

```json
{
  "name": "@primer/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "primer-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "node scripts/build.mjs",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "@primer/shared": "workspace:*",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "tsx": "^4.21.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.5",
    "esbuild": "^0.27.0"
  }
}
```

Pin `@modelcontextprotocol/sdk` and `zod` to concrete versions **≥14 days old** (the workspace gate). Use `@primer/shared` for the API DTO types so request/response shapes stay in sync.

- [ ] **Step 2: `tsconfig.json` + `vitest.config.ts`** — copy `apps/api`'s (node env, ESM, `.ts` import extensions).
- [ ] **Step 3: `scripts/build.mjs`** — esbuild bundle `src/index.ts` → `dist/index.js`, platform node, format esm, with a `#!/usr/bin/env node` shebang banner so the `bin` is executable.
- [ ] **Step 4: Install**

```
pnpm install
```

Expect the lockfile to update; **no** build-script approval prompt. If prompted, stop and ask.

- [ ] **Step 5: Typecheck (empty) + commit**

```
git add apps/mcp pnpm-lock.yaml
git commit -m "build(mcp): scaffold @primer/mcp stdio server package"
```

---

### Task B2: API client (TDD)

**Files:** Create `apps/mcp/src/client.ts`, `apps/mcp/src/client.test.ts`.

- [ ] **Step 1: Failing tests with a mocked `fetch`** — assert:
  - `whoami()` GETs `${base}/api/me` with `Authorization: Bearer <token>`.
  - `createDocument({title, content, format:'markdown'})` POSTs multipart to `/api/upload` with a `file` part named `doc.md` (and `doc.html` for html), a `title` part, and the bearer header; returns the parsed JSON.
  - `addVersion(documentId, …)` POSTs multipart to `/api/documents/:id/versions`.
  - `getVersionThreads(versionId)` GETs `/api/versions/:id/threads`.
  - error mapping: a 401 response throws an error whose message mentions an invalid/expired token; 403 → not the uploader; 404 → not found; 400 → includes the server `message`.
  - the base URL is normalized (trailing slash trimmed).

- [ ] **Step 2: Implement `PrimerClient`** — a class holding `baseUrl`/`token`; a private `request()` that sets the bearer header, parses JSON, and throws a typed `PrimerApiError` mapping status→message; `createDocument`/`addVersion` build `FormData` with `new Blob([content], { type })` and the right filename; methods return the `@primer/shared` DTO types.

- [ ] **Step 3: Run tests + typecheck** (PASS). Commit:

```
git add apps/mcp/src/client.ts apps/mcp/src/client.test.ts
git commit -m "feat(mcp): authenticated Primer API client"
```

---

### Task B3: Comment formatter (TDD)

**Files:** Create `apps/mcp/src/format.ts`, `apps/mcp/src/format.test.ts`.

- [ ] **Step 1: Failing tests** — `formatComments(threadsListResponse)` returns a markdown string that, for a sample with two threads (one open, one resolved, one with a tombstoned comment):
  - shows a header with the thread count and open/resolved counts;
  - per thread: the anchor's `selectorText` (or element path), open/resolved state, and each non-deleted comment as `author — body (timestamp)`;
  - renders tombstoned comments as `(deleted)` rather than empty;
  - handles the empty case (`No comments on this version.`).

- [ ] **Step 2: Implement** the pure formatter against the `ThreadsListResponse`/`ThreadDTO`/`CommentDTO` shapes from `@primer/shared`.

- [ ] **Step 3: Tests + typecheck** (PASS). Commit:

```
git add apps/mcp/src/format.ts apps/mcp/src/format.test.ts
git commit -m "feat(mcp): comment thread formatter for review output"
```

---

### Task B4: Tools (TDD)

**Files:** Create `apps/mcp/src/tools.ts`, `apps/mcp/src/tools.test.ts`.

- [ ] **Step 1: Failing tests** — a `registerTools(server, client)` (client is a mock implementing the `PrimerClient` interface) registers the six tools (spec Section 4). Test each handler by invoking it directly (extract handlers into testable functions, or call through the SDK's in-memory linked transport). Assert:
  - `primer_create_document` calls `client.createDocument` with the parsed args and returns `structuredContent` `{ documentId, versionId, url }` plus a text summary containing the URL.
  - `primer_add_version` → `client.addVersion`, returns `{ versionId, versionNumber, url }`.
  - `primer_get_comments` accepts **either** `{ versionId }` or `{ documentId }`; given only `documentId` it first calls `client.getDocument` to resolve `latestVersion.id`, then `client.getVersionThreads`, and returns the formatter output.
  - invalid args (missing `title`, bad `format`) are rejected by the zod schema.
  - a `PrimerApiError` from the client surfaces as an MCP tool error with the mapped message.

- [ ] **Step 2: Implement `tools.ts`** — zod input schemas per tool; handlers delegate to the client and shape `{ content: [{type:'text', text}], structuredContent }`; errors are caught and returned as `isError` tool results with a readable message.

- [ ] **Step 3: Tests + typecheck** (PASS). Commit:

```
git add apps/mcp/src/tools.ts apps/mcp/src/tools.test.ts
git commit -m "feat(mcp): create/add-version/get-comments and supporting tools"
```

---

### Task B5: Bootstrap + README

**Files:** Create `apps/mcp/src/index.ts`, `apps/mcp/README.md`.

- [ ] **Step 1: `index.ts`** — read `PRIMER_API_URL` + `PRIMER_API_TOKEN`; if either is blank, `console.error` a clear message and `process.exit(1)`; construct `PrimerClient`, an `McpServer`, call `registerTools`, connect a `StdioServerTransport`. No secret is ever logged.

- [ ] **Step 2: Build + manual smoke** against a local API in mock mode:

```
pnpm --filter @primer/mcp build
PRIMER_API_URL=http://localhost:3000 PRIMER_API_TOKEN=primer_pat_… \
  npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js
```

Exercise `primer_whoami`, `primer_create_document`, `primer_get_comments` in the inspector.

- [ ] **Step 3: `README.md`** — what it is; the `claude mcp add primer …` command and a `.mcp.json` snippet; the two env vars; how to mint a token (link the settings page); the tool list; that content is passed inline and the 10 MB limit applies.

- [ ] **Step 4: Full suite + typecheck**

```
pnpm typecheck && pnpm test
```

- [ ] **Step 5: Commit**

```
git add apps/mcp/src/index.ts apps/mcp/README.md
git commit -m "feat(mcp): stdio bootstrap + usage docs"
```

- [ ] **Step 6 (stretch, optional): in-memory integration test** — boot `createApp({ storage, notifier, userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver) })`, seed a user + token, and drive a `PrimerClient` whose `fetch` is `app.request`. Assert a full create → add-version → get-comments round-trip. Commit separately if added.

---

# Sub-project C — `primer` skill

### Task C1: SKILL.md + reference

**Files:** Create `.claude/skills/primer/SKILL.md`, `.claude/skills/primer/reference.md`.

- [ ] **Step 1: `SKILL.md`** — frontmatter (`name: primer`, the trigger-rich `description` from spec Section 5) + the workflow body: preflight (tools present? token valid via `primer_whoami`?), create-vs-iterate with `.primer/document.json` persistence, share the URL, iterate via `primer_add_version` with a `versionNote`, gather feedback via `primer_get_comments` then address-and-repush. Keep it tight; defer details to `reference.md`.

- [ ] **Step 2: `reference.md`** — full tool I/O (args, returns, error meanings), format selection rules (`.md`/`.markdown` → markdown else html), the 10 MB limit, the two upload mutations Primer makes (`<iframe>` / `<meta refresh>` stripped), the `.primer/document.json` schema, and the "never echo the token" rule.

- [ ] **Step 3: Dogfood** — in a Claude Code session with the MCP configured against a local mock-mode API: ask the agent to "publish this as a Primer doc", confirm it creates the doc, writes `.primer/document.json`, returns a URL; then "make a change and update it" → new version; then "what feedback is there?" → `primer_get_comments`. Capture any wording fixes back into the skill.

- [ ] **Step 4: Commit**

```
git add .claude/skills/primer/
git commit -m "feat(skill): primer publish/iterate/feedback agent skill"
```

---

## Final verification

- [ ] `pnpm verify` (typecheck + test + `pnpm audit --audit-level=high`) is green across all workspaces.
- [ ] Manual end-to-end in mock mode: mint a token in the web UI → configure `@primer/mcp` → from an agent, create a doc, add a version, fetch comments.
- [ ] Spec ↔ implementation diff review: confirm no existing route handler changed behavior; bearer requests skip CSRF; cookie requests still require the CSRF header.
- [ ] Do **not** push or open a PR unless explicitly asked. When asked, push to `claude/primer-api-mcp-agent-xzkzl`.

## Deployment notes (operational, outside the code plan)

- No new server env for SP-A (tokens are self-served). The MCP server's env (`PRIMER_API_URL`, `PRIMER_API_TOKEN`) lives on the **agent's** machine, never in Railway.
- Optionally add the `primer_pat_` prefix to GitHub secret-scanning / push-protection patterns.
- `@primer/mcp` distribution (internal registry vs. `npx` from a tarball) is an ops decision; v1 can run via `node apps/mcp/dist/index.js` or `npx` against the built package.
