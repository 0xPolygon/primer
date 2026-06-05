# Primer API + MCP + Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CLI agent publish to Primer with a zero-copy-paste login: the agent starts a device-authorization flow, the user approves in the browser (where they're already signed into Okta), and the CLI auto-receives a token. The agent then creates a document, uploads new versions as the user iterates, and fetches a version's comments for feedback. Delivered as three layers — (A) device-flow auth + bearer tokens on the existing API, (B) a `@primer/mcp` stdio server with a built-in login flow, (C) a `primer` Claude Code skill.

**Architecture:** A bearer resolver is composed ahead of the existing okta/mock resolver so a `primer_pat_…` token resolves to its owner; CSRF exempts bearer-authed requests and the two public device endpoints. The device grant (RFC 8628) issues those tokens: `POST /api/device/authorize` + `POST /api/device/token` (public) for the CLI, and a browser approval page (`GET /device` + `POST /api/device/approve|deny`, cookie-authed) for the user. The MCP server drives the flow, stores the token locally, and wraps the existing REST API. No existing data-route handler changes behavior.

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
- `apps/api/src/routes/device.ts` (+ `.test.ts`) — device authorize/token/approve/deny.
- `apps/api/src/routes/tokens.ts` (+ `.test.ts`) — list/revoke (+ optional mint).
- `apps/api/drizzle/0005_*.sql` — generated migration (both tables).

Modified (shared/API):
- `packages/shared/src/schema.ts` — `apiTokens`, `deviceAuthorizations`.
- `packages/shared/src/api.ts` — token + device DTOs.
- `apps/api/src/app.ts` — `AppVariables.authMethod`; register device + token routes.
- `apps/api/src/auth/resolver.ts` — set `authMethod` in mock/okta resolvers.
- `apps/api/src/middleware/auth.ts` — add `/api/device/authorize` + `/api/device/token` to public paths.
- `apps/api/src/auth/csrf.ts` — exempt bearer + the two public device endpoints.
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

export function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomBytes(1)[0] % USER_CODE_ALPHABET.length];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `${block()}-${block()}`;
}
```

- [ ] **Step 4:** Tests pass; commit `feat(api): token + device/user code generation helpers`.

---

### Task A3: Bearer resolver + compose (TDD)

**Files:** Create `apps/api/src/auth/bearer.ts`, `apps/api/src/auth/bearer.test.ts`. Modify `apps/api/src/app.ts` (add `authMethod`) and `apps/api/src/auth/resolver.ts`.

- [ ] **Step 1:** Add `authMethod?: 'bearer' | 'cookie' | 'mock'` to `AppVariables` in `app.ts`.
- [ ] **Step 2:** Failing tests for `makeBearerResolver()` against the test DB: null when no/невalid header; resolves a valid token to its user + sets `authMethod='bearer'`; null for revoked and for expired tokens. Plus `composeResolvers` returns the first non-null. (Mirror the context stub used in `resolver.test.ts`.)
- [ ] **Step 3:** Verify failure.
- [ ] **Step 4: Implement `bearer.ts`** (validation query + throttled `last_used_at` touch + `composeResolvers`) as in the spec; `makeBearerResolver` reads `authorization`, requires `Bearer ` + `TOKEN_PREFIX`, hashes, queries, returns `{ id, email, displayName }` or null.
- [ ] **Step 5:** In `resolver.ts`, have `mockResolver`/`mockMultiResolver` set `authMethod='mock'` and `makeOktaResolver` set `authMethod='cookie'` on success (return values unchanged).
- [ ] **Step 6:** Tests + typecheck pass; commit `feat(api): bearer token resolver + resolver composition`.

---

### Task A4: CSRF exemption (TDD)

**Files:** Modify `apps/api/src/auth/csrf.ts`, `apps/api/src/auth/csrf.test.ts`.

- [ ] **Step 1:** Failing tests: a mutating request with `authMethod==='bearer'` passes without the header; the two public device paths pass without it; a cookie/mock mutating request without the header still 403s.
- [ ] **Step 2: Implement.** Type `csrfMiddleware` as `MiddlewareHandler<{ Variables: AppVariables }>`; after the method guard, before the header check:

```ts
  if (c.get('authMethod') === 'bearer') return next();
  if (c.req.path === '/api/device/authorize' || c.req.path === '/api/device/token') return next();
```

- [ ] **Step 3:** Tests + typecheck pass; commit `feat(api): CSRF exempt bearer requests + public device endpoints`.

---

### Task A5: Device-flow routes (TDD)

**Files:** Create `apps/api/src/routes/device.ts`, `apps/api/src/routes/device.test.ts`; modify `apps/api/src/middleware/auth.ts` (public paths) and `apps/api/src/app.ts` (register, pass base URL).

- [ ] **Step 1:** Add `/api/device/authorize` and `/api/device/token` to `PUBLIC_PATHS` in `middleware/auth.ts`.
- [ ] **Step 2: Failing end-to-end tests** using the harness (`asUserJson`, `CSRF_HEADERS`). Cover the full handshake:
  - `POST /api/device/authorize` (no auth) → 200 with `userCode`, `deviceCode`, `verificationUri`, `verificationUriComplete` (contains the code), `expiresIn`, `interval`.
  - `POST /api/device/token` while pending → 400 `authorization_pending`.
  - polling again immediately → 400 `slow_down`.
  - `POST /api/device/approve` `{ userCode }` as a user → 200; then `POST /api/device/token` (after the interval; in tests, force `last_polled_at` back or set `intervalSeconds: 0`) → 200 with a `token` starting `primer_pat_`.
  - the issued token authenticates: `app.request('/api/me', { headers: { authorization: 'Bearer '+token } })` → 200 as the approver (build the app with `composeResolvers(makeBearerResolver(), mockMultiResolver)`).
  - a second poll after success → 400 `invalid_grant` (consumed); the `api_tokens` row persists.
  - `approve` of an unknown/expired code → 404/`expired_token`; `deny` then poll → 400 `access_denied`.
  - approve requires auth + CSRF (no header → 403; no session in okta mode → handled by middleware).
- [ ] **Step 3:** Verify failure.
- [ ] **Step 4: Implement `device.ts`.** `registerDeviceRoutes(app, { baseUrl })`:
  - `authorize`: generate device + user codes, insert pending row (`expiresAt = now + 600s`, `intervalSeconds = 5`, `clientLabel` from body), return the response with `verificationUri = ${baseUrl}/device`, `verificationUriComplete = ${baseUrl}/device?code=${userCode}`.
  - `token`: hash `deviceCode`, load row; expired → `expired_token`; enforce interval via `last_polled_at` (else `slow_down`, always update `last_polled_at`); `denied` → `access_denied`; `consumed`/missing → `invalid_grant`; `pending` → `authorization_pending`; `approved` → `generateToken()`, insert `api_tokens` (`name = clientLabel ?? 'device login'`, `userId = row.userId`, optional default expiry), set device row `status='consumed'`, return `{ token, tokenPrefix, expiresAt }`.
  - `approve`/`deny`: cookie-authed; look up by `userCode`, must be pending + not expired; set `status` + (`approve`) `userId = c.get('user').id`; return `{ clientLabel }`.
- [ ] **Step 5:** Register in `app.ts` (`registerDeviceRoutes(app, { baseUrl: deps.authBaseUrl ?? process.env.AUTH_BASE_URL ?? '' })` — thread a base URL through `AppDeps` or read env; default to relative paths if blank).
- [ ] **Step 6:** Tests + typecheck pass; commit `feat(api): RFC-8628 device authorization endpoints`.

---

### Task A6: Token list/revoke routes (TDD)

**Files:** Modify `packages/shared/src/api.ts` (DTOs); create `apps/api/src/routes/tokens.ts`, `apps/api/src/routes/tokens.test.ts`; register in `app.ts`.

- [ ] **Step 1:** Append token + device DTOs (spec Section 3) to `api.ts`.
- [ ] **Step 2:** Failing tests: `GET /api/tokens` lists the caller's tokens (incl. a device-issued one), no `token` field; `DELETE /api/tokens/:id` by owner → 200 and the token stops authenticating (`/api/me` → 401); delete of another user's token → 404; optional `POST /api/tokens` mints + returns plaintext once and authenticates.
- [ ] **Step 3:** Implement `registerTokenRoutes` (`GET`, `DELETE`, optional `POST`) — owner-scoped queries, `toSummary` never includes the secret. Register in `app.ts`.
- [ ] **Step 4:** Tests + typecheck pass; commit `feat(api): token list/revoke routes (+ optional manual mint)`.

---

### Task A7: Boot wiring + purge

**Files:** Modify `apps/api/src/index.ts`, `apps/api/src/jobs/purge.ts` (+ `.test.ts`).

- [ ] **Step 1:** In `index.ts`, wrap the chosen resolver: `userResolver = composeResolvers(makeBearerResolver(), base)` in **both** auth modes; ensure `AUTH_BASE_URL` reaches the device routes.
- [ ] **Step 2:** Add `purgeStaleDeviceAuthorizations` (`expires_at < now() - interval '1 day'`) and `purgeRevokedTokens` (`revoked_at < now() - interval '30 days'`) to `purge.ts`, called from the same tick; tests mirror existing purge tests.
- [ ] **Step 3:** `pnpm typecheck && pnpm test` (full suite).
- [ ] **Step 4: Manual smoke (mock mode):**

```
pnpm dev
# start a device flow:
curl -s localhost:3000/api/device/authorize -X POST -H 'content-type: application/json' -d '{"clientLabel":"smoke"}'
# open the verificationUriComplete in a browser (mock user is auto-authed), click Approve (Task A8),
# then poll:
curl -s localhost:3000/api/device/token -X POST -H 'content-type: application/json' -d '{"deviceCode":"…"}'
# use the returned token:
curl -s localhost:3000/api/me -H "authorization: Bearer primer_pat_…"
```

- [ ] **Step 5:** Commit `feat(api): enable bearer auth at boot + purge stale device/token rows`.

---

### Task A8: Web — approval page + token settings

**Files:** Create `apps/web/src/routes/device.tsx`, `apps/web/src/queries/device.ts`, `apps/web/src/queries/tokens.ts`, `apps/web/src/routes/settings-tokens.tsx`; register routes + nav (read existing router/AppShell + `lib/fetch.ts` first).

- [ ] **Step 1:** `queries/device.ts` — `useApproveDevice`/`useDenyDevice` (POST via the `api()` wrapper so CSRF + 401 handling come free). `queries/tokens.ts` — `useApiTokens`/`useRevokeToken` (+ optional `useCreateToken`).
- [ ] **Step 2:** `/device` page (`device.tsx`) — read `?code=`, show the code in an editable field (pre-filled), display "A command-line tool is requesting access to your Primer account as **<me.email>**" (uses `useMe`), with **Approve** and **Deny** buttons → call the mutations → show a success/denied confirmation ("You can return to your terminal."). Handle expired/unknown codes gracefully.
- [ ] **Step 3:** `settings-tokens.tsx` — list tokens (name, `prefix…`, created, last used, expiry, revoked), revoke per row (confirm); optional manual-mint form showing the secret once via `clipboardCopy.ts`.
- [ ] **Step 4:** Register both routes; add a nav entry to the token page (e.g. user menu in `AppShell.tsx`).
- [ ] **Step 5:** `pnpm typecheck && pnpm test`; manual `pnpm dev` round-trip of the full device flow (authorize via curl → approve in `/device` → poll → token works) and a token revoke.
- [ ] **Step 6:** Commit `feat(web): device approval page + API token settings`; update `README.md` with a "Programmatic access (device login)" section. Commit.

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

- [ ] **Step 1:** Failing tests (tmp dir + injected path/env): resolution precedence (`PRIMER_API_TOKEN` env > file > none); `save()` writes `{ token }` with mode `0600` and `mkdir -p`; `load()` returns null when absent/malformed; `clear()` removes it.
- [ ] **Step 2:** Implement `resolveToken(env)`, `saveToken(token)`, `loadToken()`, `clearToken()` (default path `~/.config/primer/token.json`, `PRIMER_TOKEN_FILE` override).
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): local token store with env override`.

---

### Task B3: API client (TDD)

**Files:** `apps/mcp/src/client.ts` (+ `.test.ts`).

- [ ] **Step 1:** Failing tests (mocked `fetch`): `whoami`/`getDocument`/`listVersions`/`getVersionThreads` GET the right paths with `Authorization: Bearer`; `createDocument`/`addVersion` POST multipart (`file` part named `doc.md`/`doc.html`, `title`/`versionNote` parts); base-URL normalization; error mapping (401→auth, 403→not uploader, 404→not found, 400→server message).
- [ ] **Step 2:** Implement `PrimerClient` (`baseUrl`, `token`) + private `request()` + `PrimerApiError`; uploads via `FormData` + `Blob`; returns `@primer/shared` DTO types.
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): authenticated Primer API client`.

---

### Task B4: Device login helpers (TDD)

**Files:** `apps/mcp/src/deviceLogin.ts` (+ `.test.ts`).

- [ ] **Step 1:** Failing tests (mocked `fetch`): `startDeviceLogin(baseUrl, clientLabel)` POSTs `/api/device/authorize` and returns the response; `pollOnce(baseUrl, deviceCode)` maps `authorization_pending`/`slow_down`/`access_denied`/`expired_token`/`invalid_grant` and the 200 success to a tagged result; a `pollUntil(...)` loop honors `interval`, backs off on `slow_down`, and stops on terminal states/timeout (use fake timers).
- [ ] **Step 2:** Implement the helpers (pure aside from `fetch`); no token persistence here (the caller decides).
- [ ] **Step 3:** Tests + typecheck; commit `feat(mcp): device-authorization login helpers`.

---

### Task B5: Format + tools (TDD)

**Files:** `apps/mcp/src/format.ts`, `apps/mcp/src/tools.ts` (+ `.test.ts` each).

- [ ] **Step 1:** Failing `format.test.ts`: `formatComments(threadsListResponse)` → markdown (thread/open/resolved counts; per thread the anchor `selectorText`/path, state, and each non-deleted comment as `author — body (ts)`; tombstones as `(deleted)`; empty case). Implement.
- [ ] **Step 2:** Failing `tools.test.ts`: `registerTools(server, { client, store, baseUrl })` registers login + data tools. Assert via direct handler invocation (or SDK in-memory transport):
  - `primer_login` → `startDeviceLogin`, stashes `deviceCode` in memory, returns `{ verificationUri, verificationUriComplete, userCode }` + relay text.
  - `primer_login_status` → `pollOnce`; on `approved` writes token via the store; returns the state.
  - `primer_logout` → `clearToken`.
  - `primer_create_document` / `primer_add_version` / `primer_get_document` / `primer_list_versions` → delegate to a client built from the resolved token; data tools with no token return a clear "run primer_login" error.
  - `primer_get_comments` accepts `{ versionId }` or `{ documentId }` (resolves latest via `getDocument`) → `formatComments`.
  - zod rejects bad args; `PrimerApiError` surfaces as an MCP tool error.
- [ ] **Step 3:** Implement `format.ts` + `tools.ts`. Tests + typecheck.
- [ ] **Step 4:** Commit `feat(mcp): comment formatter + login/data tools`.

---

### Task B6: Bootstrap + CLI subcommand + README

**Files:** `apps/mcp/src/index.ts`, `apps/mcp/README.md`.

- [ ] **Step 1:** `index.ts` — require `PRIMER_API_URL` (else stderr + exit 1). If `argv[2] === 'login'`, run the interactive CLI device login (print URL + code, optionally open browser, `pollUntil`, `saveToken`, exit). Otherwise construct an `McpServer`, `registerTools`, connect `StdioServerTransport`. Never log the token.
- [ ] **Step 2:** Build + manual smoke against a local mock-mode API:

```
pnpm --filter @primer/mcp build
PRIMER_API_URL=http://localhost:3000 node apps/mcp/dist/index.js login   # CLI flow
PRIMER_API_URL=http://localhost:3000 npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js  # tools
```

Exercise `primer_login` → approve in browser → `primer_login_status` → `primer_whoami` → `primer_create_document` → `primer_get_comments`.

- [ ] **Step 3:** `README.md` — `claude mcp add primer --env PRIMER_API_URL=… -- npx -y @primer/mcp`; the login UX (in-agent tools vs `primer-mcp login`); env vars + token store path; tool list; inline-content + 10 MB note.
- [ ] **Step 4:** `pnpm typecheck && pnpm test`. Commit `feat(mcp): stdio bootstrap, login subcommand, usage docs`.
- [ ] **Step 5 (stretch):** in-memory integration test (boot `createApp` with a bearer-composed resolver; drive a real `PrimerClient` over `app.request` for create→add-version→get-comments). Commit separately.

---

# Sub-project C — `primer` skill

### Task C1: SKILL.md + reference

**Files:** `.claude/skills/primer/SKILL.md`, `.claude/skills/primer/reference.md`.

- [ ] **Step 1:** `SKILL.md` — frontmatter (spec Section 5) + workflow: **auth preflight** (`primer_whoami`; on failure run `primer_login`, show the user the URL + code, ask them to approve, then `primer_login_status` until approved), create-vs-iterate with `.primer/document.json`, share the URL, iterate via `primer_add_version` + note, feedback via `primer_get_comments` then address-and-repush. Keep tight.
- [ ] **Step 2:** `reference.md` — full tool I/O incl. the login sequence, format selection (`.md`/`.markdown`→markdown else html), 10 MB limit, the two upload mutations (`<iframe>`/`<meta refresh>` stripped), `.primer/document.json` schema, "never echo the token", and the "MCP not configured → `claude mcp add primer …`" guidance.
- [ ] **Step 3: Dogfood** in a Claude Code session with the MCP pointed at a local mock-mode API: "publish this to Primer" → triggers login (approve in browser) → creates doc → writes `.primer/document.json` → returns URL; "update it" → new version; "what feedback is there?" → `primer_get_comments`. Fold wording fixes back in.
- [ ] **Step 4:** Commit `feat(skill): primer login/publish/iterate/feedback agent skill`.

---

## Final verification

- [ ] `pnpm verify` (typecheck + test + `pnpm audit --audit-level=high`) green across all workspaces.
- [ ] Full manual end-to-end in mock mode: agent `primer_login` → browser approve at `/device` → token auto-stored → create doc → add version → fetch comments.
- [ ] Diff review: no existing data-route handler changed behavior; bearer + public device endpoints skip CSRF; cookie requests still require the CSRF header; tokens minted only on first post-approval poll and never stored in plaintext.
- [ ] Do **not** push or open a PR unless explicitly asked. When asked, push to `claude/primer-api-mcp-agent-xzkzl`.

## Deployment notes (operational, outside the code plan)

- `AUTH_BASE_URL` must be set in prod so `verificationUri`/`verificationUriComplete` are absolute and clickable. No other new server env for SP-A.
- The MCP server's `PRIMER_API_URL` (and optional `PRIMER_API_TOKEN`/`PRIMER_TOKEN_FILE`) live on the **agent's** machine; the device-issued token is written to `~/.config/primer/token.json` (`0600`), never to the repo or Railway.
- Optionally add the `primer_pat_` prefix to GitHub secret-scanning / push-protection patterns.
- `@primer/mcp` distribution (internal registry vs. `npx` tarball) is an ops decision; v1 can run via `node apps/mcp/dist/index.js`.
