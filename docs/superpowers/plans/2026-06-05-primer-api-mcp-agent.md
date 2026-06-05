# Primer API + MCP + Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CLI agent publish to Primer with a zero-copy-paste login: the agent starts a device-authorization flow, the user approves in the browser (where they're already signed into Okta), and the CLI auto-receives a token. The agent then creates a document, uploads new versions as the user iterates, and fetches a version's comments for feedback. Delivered as three layers — (A) device-flow auth + bearer tokens on the existing API, (B) a `@primer/mcp` stdio server with a built-in login flow, (C) a `primer` Claude Code skill.

**Architecture:** A bearer resolver is composed ahead of the existing okta/mock resolver so a `primer_pat_…` token resolves to its owner; CSRF exempts bearer-authed requests and the shared `PUBLIC_PATHS` set (which now includes the two public device endpoints — single source of truth, D18). The device grant (RFC 8628) issues those tokens: `POST /api/device/authorize` + `POST /api/device/token` (public) for the CLI, and a browser approval page (`GET /device` + `GET /api/device/pending` + `POST /api/device/approve|deny`, cookie-authed) for the user. **The approval page does not pre-fill the user code** — the user types it from their terminal (phishing mitigation, D13); the page fetches `/api/device/pending` to display the requester's `clientLabel`, IP, and request age. Device-issued tokens default to a 90-day expiry; the MCP server drives the flow, stores the token locally (keyed by `PRIMER_API_URL`, atomic writes), and wraps the existing REST API. Tool errors carry a machine-checkable `code` taxonomy. No existing data-route handler changes behavior.

**Tech Stack:** Hono (Node 24) + Drizzle + postgres (API); React 19 + Vite + Tailwind 4 (web); new `apps/mcp` on `@modelcontextprotocol/sdk` + `zod`. TypeScript everywhere, Vitest (node env; pure-logic + mocked-fetch tests, no JSDOM).

**Spec:** `docs/superpowers/specs/2026-06-05-primer-api-mcp-agent-design.md`

**Important constraints from project memory:**
- Use `pnpm`, not `npm`. Node 24 LTS.
- Never `git push` without explicit instruction in the turn — `master` auto-deploys to Railway. Every task ends with a commit; pushing is the user's call. This plan targets the feature branch `claude/primer-api-mcp-agent-xzkzl`.
- Don't skip git hooks (`--no-verify`) or signing.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge: 14 days`, `allowBuilds: { esbuild: true }`, `blockExoticSubdeps`, `strictPeerDependencies`. New deps must clear the 14-day gate and ship no postinstall scripts. If `pnpm` prompts to approve a build script, **stop and ask**.
- NixOS dev box: ensure both `pnpm` and the Nix-store `node` are on `PATH` before `pnpm install`.
- Migrations: edit `packages/shared/src/schema.ts`, run `pnpm db:generate`, commit the SQL; apply with `pnpm db:migrate` / `pnpm db:migrate:test`.

---

## File map

**Sub-project A — device-flow auth + bearer tokens**

New (shared/API):
- `apps/api/src/auth/tokens.ts` (+ `.test.ts`) — token + device-code/user-code generate/hash helpers.
- `apps/api/src/auth/bearer.ts` (+ `.test.ts`) — `makeBearerResolver`, `composeResolvers`.
- `apps/api/src/routes/device.ts` (+ `.test.ts`) — device authorize/token/approve/deny/**pending**.
- `apps/api/src/routes/tokens.ts` (+ `.test.ts`) — list/revoke only (no manual mint in v1, D19).
- `apps/api/drizzle/0005_*.sql` — generated migration (both tables).

Modified (shared/API):
- `packages/shared/src/schema.ts` — `apiTokens`, `deviceAuthorizations`.
- `packages/shared/src/api.ts` — token + device DTOs.
- `apps/api/src/app.ts` — `AppVariables.authMethod`; register device + token routes.
- `apps/api/src/auth/resolver.ts` — set `authMethod` in mock/okta resolvers.
- `apps/api/src/middleware/auth.ts` — **export** `PUBLIC_PATHS` (was private); add `/api/device/authorize` + `/api/device/token` to it (D18).
- `apps/api/src/auth/csrf.ts` — exempt bearer requests; import + reuse `PUBLIC_PATHS` (no duplicated path literals).
- `apps/api/src/index.ts` — compose bearer resolver in both modes; pass `AUTH_BASE_URL` to device routes.
- `apps/api/src/jobs/purge.ts` (+ `.test.ts`) — purge stale device rows + revoked tokens.

New/Modified (web):
- `apps/web/src/routes/device.tsx` — `/device` approval page.
- `apps/web/src/queries/device.ts`, `apps/web/src/queries/tokens.ts`.
- `apps/web/src/routes/settings-tokens.tsx` — token list/revoke page.
- route registration + nav entries (read existing router/AppShell first).

**Sub-project B — `@primer/mcp` stdio server**

New (`apps/mcp/`): `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `README.md`, and `src/{client,tokenStore,deviceLogin,format,tools,index}.ts` each with a sibling `.test.ts` where logic warrants.

**Sub-project C — `primer` skill**

New: `.claude/skills/primer/SKILL.md`, `.claude/skills/primer/reference.md`.

---

# Sub-project A — device-flow auth + bearer tokens

### Task A1: Schema + migration (both tables)

**Files:** Modify `packages/shared/src/schema.ts`; create `apps/api/drizzle/0005_*.sql` (generated).

- [ ] **Step 1:** Append `apiTokens` and `deviceAuthorizations` to `schema.ts` exactly as in spec Section 2. (`uniqueIndex`, `index`, `integer` are already imported.)
- [ ] **Step 2:** `pnpm db:generate` → review the new `0005_*.sql` + `drizzle/meta`.
- [ ] **Step 3:** `pnpm db:up && pnpm db:migrate && pnpm db:migrate:test`.
- [ ] **Step 4:** `pnpm typecheck`.
- [ ] **Step 5:** Commit `git add packages/shared/src/schema.ts apps/api/drizzle/ && git commit -m "feat(shared): api_tokens + device_authorizations tables + migration"`.

---

### Task A2: Token + code helpers (TDD)

**Files:** Create `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/tokens.test.ts`.

- [ ] **Step 1: Failing tests** for: `generateToken()` (prefix, entropy, `hashToken(t.token) === t.tokenHash`, 8-char `tokenPrefix` contained in token); `hashToken` stable/hex; `generateDeviceCode()` (opaque base64url + matching hash); `generateUserCode()` (format `XXXX-XXXX`, alphabet excludes `0O1I`, distinct across calls).
- [ ] **Step 2:** Verify failure.
- [ ] **Step 3: Implement `tokens.ts`:**

```ts
import { randomBytes, createHash } from 'node:crypto';

export const TOKEN_PREFIX = 'primer_pat_';
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface GeneratedToken { token: string; tokenHash: string; tokenPrefix: string; }
export function generateToken(): GeneratedToken {
  const random = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashToken(token), tokenPrefix: random.slice(0, 8) };
}

export interface GeneratedDeviceCode { deviceCode: string; deviceCodeHash: string; }
export function generateDeviceCode(): GeneratedDeviceCode {
  const deviceCode = randomBytes(32).toString('base64url');
  return { deviceCode, deviceCodeHash: hashToken(deviceCode) };
}

// Rejection-sampling threshold: largest multiple of the alphabet length that
// fits in a byte. Bytes >= this value are rejected so the modulo always
// operates on a uniformly distributed range. With a 32-char alphabet this is
// 256 (no byte rejected), but the pattern keeps the function unbiased if the
// alphabet ever changes length, and satisfies CodeQL's
// js/biased-cryptographic-random check.
const USER_CODE_BYTE_LIMIT =
  Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;

function pickAlphabetChar(): string {
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < USER_CODE_BYTE_LIMIT) {
      return USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
}

export function generateUserCode(): string {
  const block = () => Array.from({ length: 4 }, pickAlphabetChar).join('');
  return `${block()}-${block()}`;
}
```

- [ ] **Step 4:** Tests pass; commit `feat(api): token + device/user code generation helpers`.

---

### Task A3: Bearer resolver + compose (TDD)

**Files:** Create `apps/api/src/auth/bearer.ts`, `apps/api/src/auth/bearer.test.ts`. Modify `apps/api/src/app.ts` (add `authMethod`) and `apps/api/src/auth/resolver.ts`.

- [ ] **Step 1:** Add `authMethod?: 'bearer' | 'cookie' | 'mock'` to `AppVariables` in `app.ts`.
- [ ] **Step 2:** Failing tests for `makeBearerResolver()` against the test DB: null when no/invalid header; resolves a valid token to its user + sets `authMethod='bearer'`; null for revoked and for expired tokens. Plus `composeResolvers`: returns the first non-null **and short-circuits** (later resolvers never run when an earlier one wins); explicit case for **"invalid bearer header + valid cookie ⇒ `authMethod='cookie'`"** (no-bearer-override-of-session-identity invariant, spec D3 / Section 6). Mirror the context stub used in `resolver.test.ts`.
- [ ] **Step 3:** Verify failure.
- [ ] **Step 4: Implement `bearer.ts`** (validation query + throttled `last_used_at` touch + `composeResolvers`) as in the spec; `makeBearerResolver` reads `authorization`, requires `Bearer ` + `TOKEN_PREFIX`, hashes, queries, returns `{ id, email, displayName }` or null.
- [ ] **Step 5:** In `resolver.ts`, have `mockResolver`/`mockMultiResolver` set `authMethod='mock'` and `makeOktaResolver` set `authMethod='cookie'` on success (return values unchanged).
- [ ] **Step 6:** Tests + typecheck pass; commit `feat(api): bearer token resolver + resolver composition`.

---

### Task A4: CSRF exemption + centralized PUBLIC_PATHS (TDD)

**Files:** Modify `apps/api/src/middleware/auth.ts` (export `PUBLIC_PATHS`, add device endpoints), `apps/api/src/auth/csrf.ts`, `apps/api/src/auth/csrf.test.ts`. (Spec D18 — one source of truth for path exemptions.)

- [ ] **Step 1:** In `middleware/auth.ts`, **export** the existing private `PUBLIC_PATHS` set and add `/api/device/authorize` and `/api/device/token` to it (auth middleware was already going to skip these; this just makes the set reusable). The existing `authMiddleware` keeps reading from the same set — no behavior change for it.
- [ ] **Step 2:** Failing tests in `csrf.test.ts`: a mutating request with `authMethod==='bearer'` passes without the header; mutating requests to **any path in `PUBLIC_PATHS`** (`/api/device/authorize`, `/api/device/token`, `/api/health`, `/auth/login`, `/auth/callback`) pass without the header; a cookie/mock mutating request to a non-public path without the header still 403s.
- [ ] **Step 3: Implement.** Type `csrfMiddleware` as `MiddlewareHandler<{ Variables: AppVariables }>`; import `PUBLIC_PATHS` from `../middleware/auth.ts`. After the method guard, before the header check:

```ts
  if (c.get('authMethod') === 'bearer') return next();
  if (PUBLIC_PATHS.has(c.req.path)) return next();
```

No string literals for paths in `csrf.ts` — the allowlist lives in one place.

- [ ] **Step 4:** Tests + typecheck pass; commit `feat(api): CSRF exempt bearer requests + share PUBLIC_PATHS with auth middleware`.

---

### Task A5: Device-flow routes (TDD)

**Files:** Create `apps/api/src/routes/device.ts`, `apps/api/src/routes/device.test.ts`; modify `apps/api/src/app.ts` (register, pass base URL). The `PUBLIC_PATHS` additions are in Task A4.

- [ ] **Step 1:** Skipped — `PUBLIC_PATHS` entries are added in A4.
- [ ] **Step 2: Failing end-to-end tests** using the harness (`asUserJson`, `CSRF_HEADERS`). Cover the full handshake:
  - `POST /api/device/authorize` (no auth) → 200 with `userCode`, `deviceCode`, `verificationUri`, `verificationUriComplete` (contains the code; informational — see Section 6 of the spec), `expiresIn`, `interval`. Setting `x-forwarded-for: 198.51.100.7, 10.0.0.1` writes `requester_ip='10.0.0.1'` (last hop) to the row.
  - `GET /api/device/pending?userCode=…` as a user → 200 with `{ clientLabel, requesterIp, createdAt, expiresAt }`; unknown code → 404; expired code → 410.
  - `POST /api/device/token` while pending → 400 `authorization_pending`.
  - polling again immediately → 400 `slow_down`.
  - `POST /api/device/approve` `{ userCode }` as a user → 200 with **`{ clientLabel, requesterIp, createdAt }`** (not just `clientLabel`); then `POST /api/device/token` (after the interval; in tests, force `last_polled_at` back or set `intervalSeconds: 0`) → 200 with `{ token, tokenPrefix, tokenId, expiresAt }`. `token` starts `primer_pat_`. `expiresAt` is **~90 days out** (assert `expiresAt > now + 89 days && expiresAt < now + 91 days`). `tokenId` is the `api_tokens.id` of the new row.
  - the issued token authenticates: `app.request('/api/me', { headers: { authorization: 'Bearer '+token } })` → 200 as the approver (build the app with `composeResolvers(makeBearerResolver(), mockMultiResolver)`).
  - a second poll after success → 400 `invalid_grant` (consumed); the `api_tokens` row persists.
  - `approve` of an unknown/expired code → 404/`expired_token`; `deny` then poll → 400 `access_denied`.
  - approve requires auth + CSRF (no header → 403; no session in okta mode → handled by middleware).
  - **No-log invariant test (D20):** spy on `logger.info`/`warn`/`error` during a successful `/api/device/token` call and assert the token plaintext **never appears** in any log record's arguments. A failing log call should immediately fail the test.
- [ ] **Step 3:** Verify failure.
- [ ] **Step 4: Implement `device.ts`.** `registerDeviceRoutes(app, { baseUrl })`:
  - `authorize`: generate device + user codes, capture `requester_ip` from `x-forwarded-for` last hop (split on `,`, trim, take last; fall back to socket address from `c.env.incoming.socket.remoteAddress` or equivalent — single helper in the route module), insert pending row (`expiresAt = now + 600s`, `intervalSeconds = 5`, `clientLabel` from body, `requesterIp`), return the response with `verificationUri = ${baseUrl}/device`, `verificationUriComplete = ${baseUrl}/device?code=${userCode}` (the latter kept for RFC compatibility — the SPA approval page ignores `?code=`, see A8).
  - `pending` (GET): cookie-authed; look up by `userCode`; 404 if missing, 410 if expired or status≠pending; otherwise return `{ clientLabel, requesterIp, createdAt, expiresAt }`.
  - `token`: hash `deviceCode`, load row; expired → `expired_token`; enforce interval via `last_polled_at` (else `slow_down`, always update `last_polled_at`); `denied` → `access_denied`; `consumed`/missing → `invalid_grant`; `pending` → `authorization_pending`; `approved` → `generateToken()`, insert `api_tokens` (`name = clientLabel ?? 'device login'`, `userId = row.userId`, **`expiresAt = now + 90 days`**), set device row `status='consumed'`, return `{ token, tokenPrefix, tokenId: inserted.id, expiresAt }`. Do **not** call `logger.*` with the token, the response body, or the token hash anywhere in this handler.
  - `approve`/`deny`: cookie-authed; look up by `userCode`, must be pending + not expired; set `status` + (`approve`) `userId = c.get('user').id`; `approve` returns `{ clientLabel, requesterIp, createdAt }`; `deny` returns `{ ok: true }`.
- [ ] **Step 5:** Register in `app.ts` (`registerDeviceRoutes(app, { baseUrl: deps.authBaseUrl ?? process.env.AUTH_BASE_URL ?? '' })` — thread a base URL through `AppDeps` or read env; default to relative paths if blank).
- [ ] **Step 6:** Tests + typecheck pass; commit `feat(api): RFC-8628 device authorization endpoints (+ pending + requester_ip + 90d token expiry)`.

---

### Task A6: Token list/revoke routes (TDD)

**Files:** Modify `packages/shared/src/api.ts` (DTOs); create `apps/api/src/routes/tokens.ts`, `apps/api/src/routes/tokens.test.ts`; register in `app.ts`.

Per spec D19, **manual mint (`POST /api/tokens`) is not in v1** — the device flow is the only mint path. This task ships only `GET` and `DELETE`.

- [ ] **Step 1:** Append token + device DTOs (spec Section 3) to `api.ts`: `DeviceAuthorizeResponse`, `DeviceTokenSuccess` (with `tokenId`), `DeviceTokenPending`, `DevicePendingResponse`, `DeviceApproveResponse`, `ApiTokenSummary`, `ApiTokensListResponse`. **Do not** add `CreateTokenRequest`/`CreateTokenResponse` — manual mint is out for v1.
- [ ] **Step 2:** Failing tests: `GET /api/tokens` lists the caller's tokens (including a device-issued one, with `expiresAt` ~90 days out), no `token` field on any row; `DELETE /api/tokens/:id` by owner → 200 and the token stops authenticating (`/api/me` → 401); delete of another user's token → 404; second delete (already revoked) → idempotent 200; no `POST /api/tokens` route registered.
- [ ] **Step 3:** Implement `registerTokenRoutes` (`GET`, `DELETE` only) — owner-scoped queries, `toSummary` never includes the secret. Register in `app.ts`.
- [ ] **Step 4:** Tests + typecheck pass; commit `feat(api): token list + revoke routes (device-issued only)`.

---

### Task A7: Boot wiring + purge

**Files:** Modify `apps/api/src/index.ts`, `apps/api/src/jobs/purge.ts` (+ `.test.ts`).

- [ ] **Step 1:** In `index.ts`, wrap the chosen resolver: `userResolver = composeResolvers(makeBearerResolver(), base)` in **both** auth modes; ensure `AUTH_BASE_URL` reaches the device routes. In **dev** (`AUTH_MODE=mock`), the SPA is served by Vite at `http://localhost:5173` (which proxies `/api/*` to :3000), so `AUTH_BASE_URL` must be set to `http://localhost:5173` for `verificationUri` to point at the SPA; in **prod** it points at the same public origin that hosts the built SPA (`https://primer.up.railway.app`). Document this in `apps/api/.env.example` or the README, whichever holds existing env guidance.
- [ ] **Step 2:** Add `purgeStaleDeviceAuthorizations` (`expires_at < now() - interval '1 day'`) and `purgeRevokedTokens` (`revoked_at < now() - interval '30 days'`) to `purge.ts`, called from the same tick; tests mirror existing purge tests.
- [ ] **Step 3:** `pnpm typecheck && pnpm test` (full suite).
- [ ] **Step 4: Manual smoke (mock mode).** Reflects the no-prefill UX from spec Section 6.

```
# Terminal 1: pnpm dev   (AUTH_BASE_URL=http://localhost:5173)
# Terminal 2:
curl -s localhost:3000/api/device/authorize -X POST -H 'content-type: application/json' -d '{"clientLabel":"smoke"}'
# Response contains userCode, deviceCode, verificationUri.
# Open verificationUri (NOT verificationUriComplete) in a browser:
#   http://localhost:5173/device
# The page (Task A8) shows requester metadata and an empty code field. Type
# the userCode from Terminal 2 into the field and click Approve.
# Then poll:
curl -s localhost:3000/api/device/token -X POST -H 'content-type: application/json' -d '{"deviceCode":"…"}'
# 200 with { token, tokenPrefix, tokenId, expiresAt: <~90 days out> }
# Use the token:
curl -s localhost:3000/api/me -H "authorization: Bearer primer_pat_…"
# Revoke:
curl -s -X DELETE localhost:3000/api/tokens/<tokenId> -H "authorization: Bearer primer_pat_…"
# Subsequent /api/me with the same token → 401.
```

- [ ] **Step 5:** Commit `feat(api): enable bearer auth at boot + purge stale device/token rows`.

---

### Task A8: Web — approval page + token settings

**Files:** Create `apps/web/src/routes/device.tsx`, `apps/web/src/queries/device.ts`, `apps/web/src/queries/tokens.ts`, `apps/web/src/routes/settings-tokens.tsx`; register routes + nav (read existing router/AppShell + `lib/fetch.ts` first).

The approval page **does not pre-fill the user code from `?code=`** (spec D13 / Section 6 — phishing mitigation). The user must read the code from their terminal and type it on the page. The page shows the request metadata fetched from `/api/device/pending` so a victim of a social-engineering attempt has a chance to notice.

- [ ] **Step 1:** `queries/device.ts` — `useDevicePending(userCode)` (a `useQuery` against `GET /api/device/pending?userCode=…`, enabled only when `userCode` length matches `XXXX-XXXX`), `useApproveDevice`/`useDenyDevice` (POST via the `api()` wrapper so CSRF + 401 handling come free). `queries/tokens.ts` — `useApiTokens`/`useRevokeToken` only (no `useCreateToken` — manual mint is out for v1 per D19).
- [ ] **Step 2:** `/device` page (`device.tsx`) renders three states:
  1. **Input** (default): an empty userCode input with helper text "Enter the code from your terminal." Format-validates `XXXX-XXXX` as the user types (auto-uppercase, optional auto-dash after 4 chars). **Ignore `?code=` entirely** — do not pre-fill, do not read it. (A hidden comment in the JSX explains why, citing the spec D13 phishing mitigation.) The page must NOT auto-submit.
  2. **Confirm** (once the input matches `XXXX-XXXX`): fetch `/api/device/pending` via `useDevicePending`. On 200, render:
     - "Approve programmatic access for **<me.email>**?" (uses `useMe`).
     - A "Request details" panel with: `clientLabel` (clearly labeled **"Claimed by the requesting tool — not verified"** so the user reads it skeptically), `requesterIp`, "Started <relative time> ago".
     - **Approve** and **Deny** buttons calling `useApproveDevice`/`useDenyDevice`.
     - On 404: "Unknown code. Check that you typed it correctly."
     - On 410: "This request has expired. Start a new login from your terminal."
  3. **Result**: after a successful Approve, "Access granted. You can return to your terminal." After Deny, "Access denied."
- [ ] **Step 3:** `settings-tokens.tsx` — list tokens (name, `prefix…`, created, last used, expiry, revoked), revoke per row (confirm). **No manual-mint form** (D19).
- [ ] **Step 4:** Register both routes; add a nav entry to the token page (e.g. user menu in `AppShell.tsx`).
- [ ] **Step 5:** `pnpm typecheck && pnpm test`; manual `pnpm dev` round-trip (`AUTH_BASE_URL=http://localhost:5173` so the verificationUri points at Vite): authorize via curl → open `http://localhost:5173/device` (empty input) → type the userCode → confirm metadata → Approve → poll → token works; then revoke from `/settings/tokens` and confirm `/api/me` with that token → 401. **Also try opening `verificationUriComplete` directly** and verify the code is NOT pre-filled (the page must look identical to the empty-input state).
- [ ] **Step 6:** Commit `feat(web): device approval page (no pre-fill) + token settings`; update `README.md` with a "Programmatic access (device login)" section explaining the no-pre-fill rationale. Commit.

---

# Sub-project B — `@primer/mcp` stdio server

### Task B1: Scaffold `apps/mcp`

**Files:** `apps/mcp/{package.json,tsconfig.json,vitest.config.ts,scripts/build.mjs}` (mirror `apps/api`).

- [ ] **Step 1:** `package.json` — `name: @primer/mcp`, `type: module`, `bin: { "primer-mcp": "dist/index.js" }`, scripts (`dev`/`build`/`start`/`typecheck`/`test`), deps `@modelcontextprotocol/sdk` + `zod` (pin ≥14-day-old versions) + `@primer/shared` (workspace:*), devDeps matching `apps/api`.
- [ ] **Step 2:** `tsconfig.json` + `vitest.config.ts` copied from `apps/api`; `scripts/build.mjs` = esbuild bundle to `dist/index.js` with a `#!/usr/bin/env node` banner.
- [ ] **Step 3:** `pnpm install` (expect lockfile update, **no** build-script prompt — if prompted, stop and ask).
- [ ] **Step 4:** Commit `build(mcp): scaffold @primer/mcp stdio server package` (+ `pnpm-lock.yaml`).

---

### Task B2: Token store (TDD)

**Files:** `apps/mcp/src/tokenStore.ts` (+ `.test.ts`).

Spec D11: store file is `~/.config/primer/tokens.json` (plural), **keyed by the normalized `PRIMER_API_URL`**, atomic temp+rename writes. Each entry is `{ tokenId, token, prefix, savedAt }`.

- [ ] **Step 1:** Failing tests (tmp dir + injected path/env):
  - **Schema/keying**: `saveToken({ baseUrl: 'https://primer.up.railway.app', tokenId, token, prefix })` writes a map keyed by the normalized base URL (trailing slash stripped, lowercased host). A second `saveToken` for a *different* `baseUrl` (e.g. `http://localhost:3000`) leaves the first entry intact. `loadToken('https://primer.up.railway.app')` returns the first entry; `loadToken('http://localhost:3000')` returns the second. `clearToken('https://primer.up.railway.app')` removes only that key.
  - **Mode**: the written file has mode `0600`; the directory is created with `mkdir -p`.
  - **Atomic write**: spy on `fs.promises.writeFile`/`rename` and assert the implementation writes a sibling `tokens.json.tmp`, fsyncs, then renames over `tokens.json`. A `writeFile` rejection mid-write must leave the pre-existing `tokens.json` untouched (simulate: pre-populate the file, make the temp write throw, assert the original is unchanged).
  - **Resolution precedence** (`resolveToken({ env, baseUrl })`): `PRIMER_API_TOKEN` env > store entry for `baseUrl` > undefined. The env override does NOT consult the store at all.
  - `loadToken` returns null when the file is absent or malformed JSON (and logs nothing).
- [ ] **Step 2:** Implement:
  - Types: `interface TokenStoreEntry { tokenId: string; token: string; prefix: string; savedAt: string }`; `type TokenStoreFile = Record<string, TokenStoreEntry>`.
  - `normalizeBaseUrl(s)` helper — trims trailing `/`, lowercases the host, validates it parses as a URL.
  - `resolveToken({ env, baseUrl })`, `saveToken({ baseUrl, tokenId, token, prefix })`, `loadToken(baseUrl)`, `clearToken(baseUrl)`.
  - Default path `~/.config/primer/tokens.json`, `PRIMER_TOKEN_FILE` override. Writes via `writeFile(tmpPath, …, { mode: 0o600 })` → `fsync` → `rename(tmpPath, finalPath)`. The temp file lives in the same directory so the rename is atomic.
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): per-URL atomic token store`.

---

### Task B3: API client (TDD)

**Files:** `apps/mcp/src/client.ts` (+ `.test.ts`).

`PrimerApiError` carries a machine-checkable `code` (spec D17) so the tool layer and the skill can branch without string-matching messages.

- [ ] **Step 1:** Failing tests (mocked `fetch`):
  - `whoami`/`getDocument`/`listVersions`/`getVersionThreads` GET the right paths with `Authorization: Bearer`.
  - `createDocument`/`addVersion` POST multipart (`file` part named `doc.md`/`doc.html`, `title`/`versionNote` parts).
  - `revokeToken(tokenId)` issues `DELETE /api/tokens/:tokenId`.
  - Base-URL normalization (trailing slash, etc.).
  - **Error code mapping** — every test asserts on `error.code` not the message:
    - 401 → `code: 'not_authenticated'`
    - 403 → `code: 'forbidden'`
    - 404 → `code: 'not_found'`
    - 400 → `code: 'bad_request'` with the server's `message` carried through
    - `fetch` rejects (network failure) → `code: 'network'`
    - 5xx → `code: 'bad_request'` for now with status surfaced (no retry logic in v1)
- [ ] **Step 2:** Implement:
  - `type PrimerErrorCode = 'not_authenticated' | 'forbidden' | 'not_found' | 'bad_request' | 'rate_limited' | 'network' | 'login_denied' | 'login_expired'` exported from `client.ts` (login codes live here so the device-login helpers can import them).
  - `class PrimerApiError extends Error { constructor(readonly code: PrimerErrorCode, message: string, readonly status?: number) … }`.
  - `PrimerClient({ baseUrl, token })` + private `request()` that wraps `fetch` in a try/catch (network → `PrimerApiError('network')`), checks `res.ok`, maps non-OK statuses to codes. Uploads via `FormData` + `Blob`. Returns `@primer/shared` DTO types.
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): Primer API client with error code taxonomy`.

---

### Task B4: Device login helpers (TDD)

**Files:** `apps/mcp/src/deviceLogin.ts` (+ `.test.ts`).

The helpers are **stateless** (spec D15): callers receive the `deviceCode` and pass it back. `pollUntil` is the long-poll used by `primer_login_status` and the `primer-mcp login` CLI; on timeout it returns `pending` (not an error) so the caller can re-invoke (spec D16).

- [ ] **Step 1:** Failing tests (mocked `fetch`, fake timers):
  - `startDeviceLogin({ baseUrl, clientLabel })` POSTs `/api/device/authorize` with the label and returns the full `DeviceAuthorizeResponse` (deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval).
  - `pollOnce({ baseUrl, deviceCode })` maps:
    - 200 with token body → `{ status: 'approved', token, tokenPrefix, tokenId, expiresAt }`
    - 400 `authorization_pending` → `{ status: 'pending' }`
    - 400 `slow_down` → `{ status: 'slow_down' }`
    - 400 `access_denied` → `{ status: 'denied' }`
    - 400 `expired_token` → `{ status: 'expired' }`
    - 400 `invalid_grant` → `{ status: 'expired' }` (treated as terminal)
  - `pollUntil({ baseUrl, deviceCode, interval, timeoutMs = 90_000 })`:
    - Honors the server `interval` between polls.
    - On `slow_down`, doubles the interval for the next iteration (capped).
    - On any **terminal** state (`approved`, `denied`, `expired`) returns immediately.
    - On `pending` keeps polling.
    - On **timeout** before any terminal state, returns `{ status: 'pending' }` so the caller knows to re-invoke (NOT an error).
    - On a `network`-class `PrimerApiError` from `pollOnce`, retries up to 3 times across the polling window before surfacing.
- [ ] **Step 2:** Implement the helpers in `deviceLogin.ts` (pure aside from `fetch` and `setTimeout`). Reuse `PrimerApiError` and the `PrimerErrorCode` taxonomy from B3 (`login_denied`, `login_expired` are reserved for the tool layer to translate from `pollUntil`'s status; the helper itself returns status tags, not throws, for terminal login states).
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): device-authorization login helpers (stateless, long-poll)`.

---

### Task B5: Format + tools (TDD)

**Files:** `apps/mcp/src/format.ts`, `apps/mcp/src/tools.ts` (+ `.test.ts` each).

Login tools are **stateless** (spec D15): `primer_login` returns the `deviceCode` to the agent, `primer_login_status` accepts it. `primer_login_status` long-polls internally (spec D16). `primer_logout` revokes server-side too (spec Section 6 / D11). Errors include a machine-checkable `code` (spec D17).

- [ ] **Step 1:** Failing `format.test.ts`: `formatComments(threadsListResponse)` → markdown with:
  - Header line `# Comments on <doc title> (v<n>)` followed by thread/open/resolved counts.
  - Per thread: the **anchored selection text (the literal quote)** rendered as a blockquote — **assert the test includes a thread whose `selectorText` is `"the cake is a lie"` and verify that exact string appears in the output as `> the cake is a lie`** (i.e., the formatter emits the quote, not just the CSS selector path).
  - State badge (`open` / `resolved`).
  - Each non-deleted comment as `**author** — body (timestamp)`.
  - Tombstones render as `(deleted)`.
  - Empty case ("No comments on this version.").
- [ ] **Step 2:** Failing `tools.test.ts`: `registerTools(server, { client, store, baseUrl })` registers login + data tools. Assert via direct handler invocation (or SDK in-memory transport):
  - `primer_login` → calls `startDeviceLogin` with `clientLabel = os.hostname()` by default (overridable via input); returns `{ deviceCode, userCode, verificationUri, expiresIn, interval }`. **Does NOT return `verificationUriComplete`** (spec D13 — the MCP layer drops it). No in-memory stash anywhere in the tools module.
  - `primer_login_status` accepts `{ deviceCode }`; calls `pollUntil` with `timeoutMs: 90_000`; on `approved`, calls `client.whoami()`-style mapping is not needed — the token-body itself contains `tokenId`, so the handler calls `store.saveToken({ baseUrl, tokenId, token, prefix })`. Returns `{ status: 'approved', tokenPrefix, expiresAt }` on success, `{ status: 'pending' }` on timeout (agent calls again), `{ status: 'denied' }`, `{ status: 'expired' }`, or `{ status: 'error', code }`.
  - `primer_logout`: loads the per-URL entry; if it has `tokenId`, calls `client.revokeToken(tokenId)` ignoring 404 (already revoked) and `not_authenticated` (token already invalid); then `store.clearToken(baseUrl)`. Idempotent end to end.
  - `primer_whoami` / `primer_create_document` / `primer_add_version` / `primer_get_document` / `primer_list_versions` → delegate to a client built from the resolved token; when no token is available (`resolveToken` returns undefined), the tool errors with `code: 'not_authenticated'` and message "Not authenticated — run `primer_login` first." **Assert on the error code, not the message.**
  - `primer_get_comments` accepts `{ versionId }` or `{ documentId }` (resolves latest via `getDocument`) → `formatComments`.
  - zod rejects bad args (returns a structured `bad_request`-shaped error).
  - `PrimerApiError` propagates with its `code` field into the MCP tool error — explicit test: a mocked client throwing `PrimerApiError('forbidden', ...)` results in a tool error whose serialized form carries `code: 'forbidden'`.
- [ ] **Step 3:** Implement `format.ts` + `tools.ts`. Tests + typecheck.
- [ ] **Step 4:** Commit `feat(mcp): comment formatter + stateless login + data tools (with error code taxonomy)`.

---

### Task B6: Bootstrap + CLI subcommand + README

**Files:** `apps/mcp/src/index.ts`, `apps/mcp/README.md`.

- [ ] **Step 1:** `index.ts` — require `PRIMER_API_URL` (else stderr + exit 1). If `argv[2] === 'login'`, run the interactive CLI device login: `startDeviceLogin` → print exactly the strict format from spec Section 5 (`Open this URL... / Then type this code...` — never print `verificationUriComplete`, **never auto-open the browser**) → `pollUntil({ timeoutMs: 90_000 })` in a loop, printing a heartbeat at most once per 15s so the user knows it's still polling; on `approved` call `saveToken({ baseUrl: PRIMER_API_URL, tokenId, token, prefix })`, print "Logged in." (no token), exit 0. On `denied`/`expired` exit 1 with a clear message. Otherwise (no `login` subcommand) construct an `McpServer`, `registerTools({ baseUrl: PRIMER_API_URL, store, … })`, connect `StdioServerTransport`. Never log the token.
- [ ] **Step 2:** Build + manual smoke against a local mock-mode API (with `AUTH_BASE_URL=http://localhost:5173` on the API):

```
pnpm --filter @primer/mcp build
PRIMER_API_URL=http://localhost:3000 node apps/mcp/dist/index.js login   # CLI flow
PRIMER_API_URL=http://localhost:3000 npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js  # tools
```

For the CLI flow: open the printed `verificationUri` (NOT verificationUriComplete — the CLI never prints it), type the code on the page, watch the CLI flip to "Logged in." For the MCP-Inspector flow: exercise `primer_login` → confirm the response includes `deviceCode`/`userCode`/`verificationUri` but **not** `verificationUriComplete` → approve in browser → `primer_login_status` (passing the `deviceCode` back) → `primer_whoami` → `primer_create_document` → `primer_get_comments` (confirm the rendered output includes the selection text as a blockquote) → `primer_logout` (confirm the server-side revoke: a subsequent `primer_whoami` errors with `code: 'not_authenticated'`).

- [ ] **Step 3:** `README.md` — `claude mcp add primer --env PRIMER_API_URL=… -- npx -y @primer/mcp`; the login UX (in-agent tools vs `primer-mcp login`, including why the approval page is no-pre-fill); env vars; **token store at `~/.config/primer/tokens.json` keyed by `PRIMER_API_URL`, atomic writes, mode 0600**; tool list; **error code taxonomy** (the codes the skill / callers branch on); inline-content + 10 MB note. Pin the version in the `claude mcp add` example once published (`@primer/mcp@<x.y.z>`).
- [ ] **Step 4:** `pnpm typecheck && pnpm test`. Commit `feat(mcp): stdio bootstrap, CLI login subcommand, usage docs`.
- [ ] **Step 5 (stretch):** in-memory integration test (boot `createApp` with a bearer-composed resolver; drive a real `PrimerClient` over `app.request` for create→add-version→get-comments). Commit separately.

---

# Sub-project C — `primer` skill

### Task C1: SKILL.md + reference

**Files:** `.claude/skills/primer/SKILL.md`, `.claude/skills/primer/reference.md`.

- [ ] **Step 1:** `SKILL.md` — frontmatter (spec Section 5) + workflow:
  1. **Auth preflight** — try `primer_whoami`. If the error has `code === 'not_authenticated'` (branch on `code`, NOT message text), call `primer_login`. Capture the returned `deviceCode`. Show the user the URL + code using the **strict prompt format** below — verbatim, no surrounding prose. Then call `primer_login_status` passing the captured `deviceCode`. If it returns `pending` (the 90s long-poll timed out), call it again — typical login completes in one or two calls. On `denied`/`expired`, tell the user and stop. Never print the token.
  2. **Create vs. iterate** — new artifact → `primer_create_document` (pick `format` from content/extension: `.md`/`.markdown` → markdown, else html). Save `{ documentId, lastVersionId, url, savedAt }` to `.primer/document.json` in `process.cwd()` (NOT the repo root; `mkdir -p .primer` first). Existing doc → `primer_add_version` against the recorded `documentId`.
  3. **Share** — surface the returned `url` immediately.
  4. **Iterate** — regenerate, `primer_add_version` with a concise `versionNote`.
  5. **Gather feedback** — `primer_get_comments` (latest version by default). Summarize open threads using the anchored selection text (the quote) as the locator, propose/apply fixes, then push a new version whose note references the addressed feedback.

  **Strict login prompt** (skill outputs verbatim, on its own with no surrounding prose):

  ```
  Open this URL in your browser:
    <verificationUri>

  Then type this code on the page:
    <userCode>
  ```

  **Error handling** — branch on the MCP tool error `code`, never on message text:
  - `not_authenticated` → run login flow (above)
  - `forbidden` → tell the user the document isn't theirs, stop
  - `not_found` → if it's a `.primer/document.json` reference, **prompt the user before creating a new one** — never silently overwrite
  - `bad_request` → surface the server's message
  - `network` → retry once, then surface
- [ ] **Step 2:** `reference.md` — full tool I/O incl. the login sequence (stateless: deviceCode flows from `primer_login` to `primer_login_status`); the **error code taxonomy** and what each means; format selection (`.md`/`.markdown`→markdown else html); 10 MB limit; the two upload mutations (`<iframe>`/`<meta refresh>` stripped); `.primer/document.json` schema and **cwd-not-repo-root** semantics, plus the 404-prompt-don't-overwrite rule; "never echo the token"; the "MCP not configured → `claude mcp add primer …`" guidance.
- [ ] **Step 3: Dogfood** in a Claude Code session with the MCP pointed at a local mock-mode API: "publish this to Primer" → triggers login (the skill outputs the strict prompt; approve in browser by **typing** the code) → creates doc → writes `.primer/document.json` in cwd → returns URL; "update it" → new version; "what feedback is there?" → `primer_get_comments` (confirm the rendered text includes the anchored quotes, not CSS paths). Then `rm` the artifact's document in another session via `DELETE /api/documents/:id` (or revoke from the settings page) and confirm the skill prompts before creating a new one. Fold wording fixes back in.
- [ ] **Step 4:** Commit `feat(skill): primer login/publish/iterate/feedback agent skill`.

---

## Final verification

- [ ] `pnpm verify` (typecheck + test + `pnpm audit --audit-level=high`) green across all workspaces.
- [ ] Full manual end-to-end in mock mode (`AUTH_BASE_URL=http://localhost:5173`): agent `primer_login` → browser approve at `/device` (user **types** the code; page shows requester metadata) → token auto-stored in `~/.config/primer/tokens.json` keyed by `PRIMER_API_URL` → create doc → add version → fetch comments (output contains anchored selection text as quotes) → `primer_logout` (subsequent `primer_whoami` errors `not_authenticated`).
- [ ] **Diff review:**
  - No existing data-route handler changed behavior.
  - Bearer + `PUBLIC_PATHS` skip CSRF; cookie requests still require the CSRF header.
  - Tokens minted only on first post-approval poll and never stored in plaintext.
  - Approval page does NOT pre-fill the user code from `?code=` (D13).
  - `GET /api/device/pending` surfaces `clientLabel`/`requesterIp`/`createdAt`/`expiresAt`.
  - `device_authorizations` has `requester_ip` populated from the trusted forwarded-for last hop.
  - Device-issued tokens have `expires_at ≈ now + 90 days`.
  - `DeviceTokenSuccess` includes `tokenId`; MCP store persists it; `primer_logout` calls `DELETE /api/tokens/:tokenId`.
  - Token store file is `~/.config/primer/tokens.json` (plural), keyed by `PRIMER_API_URL`, atomic temp+rename writes, mode 0600.
  - MCP tools return errors with machine-checkable `code`; skill branches on `code`, not message.
  - `primer_get_comments` formatter output includes anchor `selectorText` as the quote.
  - `POST /api/tokens` (manual mint) is NOT registered.
  - `PUBLIC_PATHS` is exported from `middleware/auth.ts` and imported by `csrfMiddleware`; no duplicated path literals in `csrf.ts`.
  - `/api/device/token` route handler does not log the token, hash, or response body (unit test asserts this).
- [ ] Do **not** push or open a PR unless explicitly asked. When asked, push to `claude/primer-api-mcp-agent-xzkzl`.

## Deployment notes (operational, outside the code plan)

- `AUTH_BASE_URL` must be set so `verificationUri` is absolute and clickable. **In prod**, point at the public SPA origin (`https://primer.up.railway.app`). **In dev**, point at the Vite SPA origin (`http://localhost:5173`) — Vite proxies `/api/*` back to :3000.
- The MCP server's `PRIMER_API_URL` (and optional `PRIMER_API_TOKEN`/`PRIMER_TOKEN_FILE`) live on the **agent's** machine; device-issued tokens land in `~/.config/primer/tokens.json` (`0600`, keyed by base URL), never in the repo or on Railway.
- Optionally add the `primer_pat_` prefix to GitHub secret-scanning / push-protection patterns.
- `@primer/mcp` distribution (internal registry vs. `npx` tarball) is an ops decision; v1 can run via `node apps/mcp/dist/index.js`. When published, recommend version-pinned `claude mcp add` invocations.
