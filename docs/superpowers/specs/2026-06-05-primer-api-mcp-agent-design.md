# Primer — Programmatic API, MCP Interface & Agent Skill (design spec)

**Status:** draft, ready for review
**Date:** 2026-06-05
**Author:** Taylan Pince (with Claude)
**Predecessor specs:** [SP5 auth + ownership](./2026-05-18-primer-auth-ownership-design.md), [SP-markdown copy/upload](./2026-05-26-primer-markdown-copy-upload-design.md)

> Companion implementation plan: `docs/superpowers/plans/2026-06-05-primer-api-mcp-agent.md`

## Goal

Let a CLI-based coding agent (Claude Code or equivalent) publish to Primer directly, with a **zero-copy-paste auth experience**:

> A user tells their agent to publish an artifact. The agent kicks off a login, hands the user a short URL to open. The user opens it in the browser where they're already signed into Primer (Okta), clicks **Approve**, and the agent's CLI automatically receives and stores a token. From then on the agent creates a document, uploads new versions as the user iterates, and can pull all comments on a version to act on feedback.

Three deliverables, one dependency chain:

1. **Programmatic API auth** — an **OAuth 2.0 Device Authorization Grant (RFC 8628)** that lets a non-browser client obtain a personal-access token (`primer_pat_…`) by having the user approve in the browser. The token itself is a bearer credential layered onto the existing REST API. The PRD lists "service-to-service auth / machine clients" as out of scope for v1; this spec lifts that exclusion deliberately and narrowly.
2. **MCP interface** — a small `@primer/mcp` stdio server that exposes Primer's operations as MCP tools, plus a `login` step that drives the device flow and stores the resulting token. Agents add it with `claude mcp add`.
3. **Agent skill** — a Claude Code skill (`primer`) that orchestrates the tools: log in if needed → create → share URL → iterate (add version) → fetch feedback → repeat.

Mental model: **the API is the capability + auth surface, the MCP is the tool surface (incl. login) for agents, and the skill is the workflow layer.** Each layer depends only on the one below it.

## Why the data side is small

The REST surface already supports every *document/version/comment* verb the workflow needs — no new data endpoints:

| Workflow step | Existing endpoint |
|---|---|
| Create document + first version | `POST /api/upload` (multipart; HTML **and** Markdown already supported) |
| Add a new version | `POST /api/documents/:docId/versions` |
| List versions | `GET /api/documents/:docId/versions` |
| Resolve latest version id | `GET /api/documents/:docId` → `latestVersion.id` |
| **Fetch all comments on a version** | `GET /api/versions/:versionId/threads` → threads **with all comments inlined** |
| Confirm identity (whoami) | `GET /api/me` |

The new work is concentrated in **authentication** (device flow + bearer tokens) plus the two thin layers (MCP, skill) on top.

## Non-goals

- **Granular token scopes / least privilege.** A token carries the full authority of the user who approved it. Per-token read-only or per-document scoping is a v2 escape hatch.
- **Remote/HTTP MCP transport.** We ship a local **stdio** server. A hosted Streamable-HTTP MCP endpoint mounted on the Hono app is a viable later phase but is explicitly out of scope here (D2).
- **A full OAuth Authorization Code server.** We implement only the device grant (RFC 8628), reusing the existing Okta-cookie session for the *approval* step. No client registry, no refresh tokens, no PKCE web-app flow.
- **Rate limiting / quotas on token use.** (Device endpoints get minimal anti-abuse — code entropy, expiry, poll throttling — but no general rate limiter.)
- **A standalone published `primer` CLI binary.** Login + tools ship inside `@primer/mcp` (a `login` subcommand + MCP tools). A curl fallback is documented only.
- **Agent-authored comments / replies.** v1 is fetch-only for comments from the agent side.
- **New document/version/comment read or write endpoints.** The existing surface is sufficient.

---

## Section 1 — Architecture overview

```
                    ┌──────────────── Login (RFC 8628 device grant) ───────────────┐
                    │                                                               │
┌──────────────────┴──────┐  1. POST /api/device/authorize        ┌────────────────▼───────────────┐
│ Claude Code / CLI agent  │ ─────────────────────────────────▶   │  Primer API (apps/api, Hono)    │
│ + `primer` skill         │  ◀──── { userCode, verifyUrl, … }     │                                 │
│ + @primer/mcp (stdio)    │                                       │  PUBLIC: /api/device/authorize  │
│                          │  2. show verifyUrl + userCode         │          /api/device/token      │
└──────┬───────────────────┘     to the user                      │                                 │
       │                                                           │  device_authorizations table   │
       │  3. user opens verifyUrl in browser (already Okta-authed) │                                 │
       │     GET /device → page shows requester metadata,          │  COOKIE: GET /device (SPA page) │
       │     user TYPES userCode from terminal, clicks Approve     │          /api/device/pending    │
       │                       POST /api/device/approve            │          /api/device/approve    │
       │                                                           │          /api/device/deny       │
       │  4. POST /api/device/token (poll, every `interval`s)      │                                 │
       │  ◀──── 200 { token: primer_pat_… }  (minted on approval)  │  mints api_tokens row           │
       │                                                           │                                 │
       │  5. store token in ~/.config/primer/tokens.json           │                                 │
       │     (keyed by PRIMER_API_URL, atomic write)               │                                 │
       ▼                                                           │                                 │
  ─── Steady state: every API call carries ───────────────────▶   │  authMiddleware:                │
      Authorization: Bearer primer_pat_…                          │   composeResolvers(             │
                                                                   │     bearerResolver,  ◀──── NEW  │
                                                                   │     oktaResolver|mock)          │
                                                                   │  csrfMiddleware (bearer-exempt) │
                                                                   │  existing data routes (unchanged)│
                                                                   └─────────────────────────────────┘
```

### Auth pipeline change (steady state)

Once a token exists, requests authenticate exactly as in the bearer design: `authMiddleware(composeResolvers(bearerResolver, fallbackResolver))`. The composite tries the `Authorization: Bearer primer_pat_…` header first, then falls through to the existing okta-cookie (prod) or mock (dev/test) resolver. The winning resolver records `c.set('authMethod', 'bearer' | 'cookie' | 'mock')`.

### CSRF change

A bearer token is not an ambient credential, so a cross-site page cannot forge a bearer-authed request. `csrfMiddleware` therefore **skips the check when `authMethod === 'bearer'`** (keyed off the winning resolver, not raw header presence). The unauthenticated device endpoints (`/api/device/authorize`, `/api/device/token`) carry no cookie either and are CSRF-exempt as well — they are added to a shared `PUBLIC_PATHS` set in `middleware/auth.ts` that both the auth middleware and CSRF middleware consume (D18). The "no permissive CORS" invariant from `csrf.ts` still holds and is reaffirmed.

### What is unchanged

Every existing data route handler reads `c.get('user')` as before. The bearer path yields the same `{ id, email, displayName }`. Ownership checks, soft-delete, mention validation, ETag/304 polling — untouched. A token-authed agent is, to the rest of the app, just its owner.

---

## Section 2 — Data model

Two new tables. `api_tokens` holds the long-lived bearer credentials; `device_authorizations` is the short-lived handshake state for the login flow.

```ts
// packages/shared/src/schema.ts (append)

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),                  // e.g. "device: my-laptop" or a manual label
    tokenHash: text('token_hash').notNull(),       // sha-256 hex of the full secret
    tokenPrefix: text('token_prefix').notNull(),   // first 8 chars of the random part, for display
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),   // nullable = no expiry
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('api_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('api_tokens_user_id_idx').on(t.userId),
  }),
);

export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull(),  // sha-256 of the device_code secret
    userCode: text('user_code').notNull(),               // human-typable, e.g. "WDJB-MZHT"
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }), // set on approval
    clientLabel: text('client_label'),                   // optional hint from the CLI (hostname); displayed on the approval page as untrusted
    requesterIp: text('requester_ip'),                   // captured at /api/device/authorize for the approval page; nullable when unknown
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDeviceHash: uniqueIndex('device_auth_device_code_hash_unique').on(t.deviceCodeHash),
    byUserCode: uniqueIndex('device_auth_user_code_unique').on(t.userCode),
  }),
);
```

**Token format.** `primer_pat_` + base64url(32 random bytes). The prefix makes leaked tokens greppable for secret scanning. Stored as `sha256(token)` hex (the unique index is the lookup key); a fast hash is appropriate for a 256-bit CSPRNG secret. `token_prefix` (8 chars) lets the UI show `primer_pat_8Jq3…` without holding the secret.

**`device_code`** is a high-entropy opaque secret (base64url(32 bytes)); only its hash is stored. The CLI keeps the plaintext to poll.

**`user_code`** is short and human-typable: 8 chars from an unambiguous alphabet (no `0/O/1/I`), formatted `XXXX-XXXX` (~40 bits). It is single-use and lives only for `expires_at` (default 10 min), which together with the short window makes guessing infeasible without a general rate limiter.

**Token issuance is deferred to first successful poll.** On approval we only set `status='approved'` + `user_id`. When the CLI's poll arrives and the row is approved, the server *then* `generateToken()`, inserts the `api_tokens` row (`name = clientLabel ?? 'device login'`, `expires_at = now + 90 days`), returns the **plaintext once**, and marks the device row `consumed`. This way the plaintext exists only in that one response and is never stored.

**Device-issued tokens expire by default.** `expires_at = now + 90 days` for any token minted via the device flow. Re-running login is cheap and writes the new token to the local store; making expiry the default prevents abandoned device tokens from accumulating indefinitely. The column stays nullable so future flows (e.g. CI long-lived tokens, scoped tokens) can opt out — device flow is the only minter that sets a default expiry.

**Validation query** (once per bearer request), unchanged from the token design:

```sql
SELECT u.id, u.email, u.display_name, t.id AS token_id
FROM api_tokens t JOIN users u ON u.id = t.user_id
WHERE t.token_hash = $1 AND t.revoked_at IS NULL
  AND (t.expires_at IS NULL OR t.expires_at > now())
LIMIT 1
```

`last_used_at` is touched fire-and-forget, throttled to ~60s, like `refreshSessionIfStale`.

**Cleanup** (added to the existing `startPurgeInterval` tick):
- `DELETE FROM device_authorizations WHERE expires_at < now() - interval '1 day'` (handshake rows are ephemeral).
- `DELETE FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days'`.

**No data migration.** New tables only.

---

## Section 3 — API surface

### Device-flow endpoints (`apps/api/src/routes/device.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/device/authorize` | **none** (public) | Start the flow. Optional body `{ clientLabel? }`. Records the requester's IP (from `x-forwarded-for` last hop or socket) and `clientLabel`. Generates `device_code` + `user_code`, stores a pending row, returns `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }`. |
| `POST` | `/api/device/token` | **none** (the `device_code` is the credential) | Poll. Body `{ deviceCode }`. Returns one of: `authorization_pending` (400), `slow_down` (400, if polled faster than `interval`), `expired_token` (400), `access_denied` (400), or **200 `{ token, tokenPrefix, expiresAt }`** on the first poll after approval (then the row is `consumed`; further polls → `invalid_grant`). |
| `GET` | `/device` | cookie/Okta (page) | The browser approval **page** (served by the SPA). The page does **not** pre-fill the code from `?code=`; the user must type it from their terminal (see Section 6, phishing mitigation). If the user isn't signed in, the existing middleware redirects through Okta and back. |
| `POST` | `/api/device/approve` | cookie/Okta + CSRF | Body `{ userCode }`. Looks up a pending, non-expired row; sets `status='approved'`, `user_id = current user`. Returns `{ clientLabel, requesterIp, createdAt }` for the post-approval confirmation. |
| `POST` | `/api/device/deny` | cookie/Okta + CSRF | Body `{ userCode }`. Sets `status='denied'`. |
| `GET` | `/api/device/pending` | cookie/Okta | Body for the approval page: takes `?userCode=…`, returns `{ clientLabel, requesterIp, createdAt, expiresAt }` for a pending row, or 404 / 410 (expired). Used so the page can display request metadata before the user clicks Approve. |

`/api/device/authorize` and `/api/device/token` are added to the centralized **`PUBLIC_PATHS`** allowlist exported from `middleware/auth.ts` and are **CSRF-exempt** (no cookie involved; the device/user codes are the security boundary). `csrfMiddleware` imports `PUBLIC_PATHS` and skips those paths plus any request with `authMethod === 'bearer'` — one source of truth, no string-literal duplication. Error bodies follow RFC 8628 naming so the shape is familiar.

The `requester_ip` column on `device_authorizations` (Section 2) is populated from the trusted forwarded-for last hop (or socket address when not behind a proxy) so the approval page can render where the request came from.

### Token-management endpoints (`apps/api/src/routes/tokens.ts`)

For visibility and revocation of device-issued tokens.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/tokens` | any authenticated identity | List the caller's tokens (metadata only — never the secret): `{ id, name, tokenPrefix, createdAt, lastUsedAt, expiresAt, revokedAt }[]`. |
| `DELETE` | `/api/tokens/:id` | owner only | Revoke (set `revoked_at`). 404 if not found/owned. Idempotent. |

Manual web-UI minting of tokens (for CI etc.) is **not** in v1; the device flow is the only mint path. See Section 7. This keeps the surface tight: every token in `api_tokens` came from an explicit Okta-authenticated approval of a specific device request.

### DTOs (`packages/shared/src/api.ts`, append)

```ts
export interface DeviceAuthorizeResponse {
  deviceCode: string; userCode: string;
  verificationUri: string;
  // Informational: the RFC's pre-filled convenience URL. Clients SHOULD display
  // verificationUri + userCode separately (see Section 6). Kept in the response
  // so the shape stays RFC-8628 friendly and tooling can render a QR if it wants.
  verificationUriComplete: string;
  expiresIn: number; interval: number;
}
export interface DeviceTokenSuccess { token: string; tokenPrefix: string; tokenId: string; expiresAt: string | null; }
export interface DeviceTokenPending { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant'; }
export interface DevicePendingResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface DeviceApproveResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
}

export interface ApiTokenSummary {
  id: string; name: string; tokenPrefix: string;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
}
export interface ApiTokensListResponse { tokens: ApiTokenSummary[]; }
```

`DeviceTokenSuccess.tokenId` is new — it lets the MCP store remember the token's id alongside the secret so `primer_logout` can call `DELETE /api/tokens/:id` for a true server-side revoke (not just a local-file delete).

### Resolver & middleware

- `makeBearerResolver()` — `Authorization: Bearer primer_pat_…` → hash → validation query → throttled `last_used_at` touch → `c.set('authMethod','bearer')`.
- `composeResolvers(...)` — first non-null wins, short-circuiting on the first match. Composed at boot in **both** auth modes (so the flow is testable under `AUTH_MODE=mock`). Test coverage explicitly includes: invalid bearer + valid cookie ⇒ `authMethod='cookie'` and CSRF still required.
- `AppVariables.authMethod?: 'bearer' | 'cookie' | 'mock'`; okta/mock resolvers set their values on success.
- `PUBLIC_PATHS` is exported from `middleware/auth.ts` as the single source of truth: `/api/health`, `/auth/login`, `/auth/callback`, plus the two new device endpoints (`/api/device/authorize`, `/api/device/token`). `csrfMiddleware` imports it and skips mutating-method checks for any path in the set, in addition to `authMethod === 'bearer'`. No duplicated string literals.

### Upload over the API

`POST /api/upload` and `POST /api/documents/:docId/versions` accept multipart form-data (`file` part + `title`/`description`/`versionNote`). The MCP server builds this with `FormData` + `Blob` — **no server change needed**.

---

## Section 4 — MCP server (`apps/mcp`, package `@primer/mcp`)

A standalone runnable workspace package (consistent with `apps/api`/`apps/web`; `packages/*` stays for libraries). Stdio MCP server with a built-in login flow.

### Configuration & token store

| Var | Required | Meaning |
|---|---|---|
| `PRIMER_API_URL` | yes | Base URL, e.g. `https://primer.up.railway.app` or `http://localhost:3000`. Used as both the API target *and* the token-store key (see below). |
| `PRIMER_API_TOKEN` | no | Explicit token (CI/override). If unset, the server uses the **token store**. |
| `PRIMER_TOKEN_FILE` | no | Override for the token store path |

**Token store is keyed by base URL.** The store file (default `~/.config/primer/tokens.json`, mode `0600`) holds a map keyed by the normalized API base URL, so a user can have separate tokens for prod, staging, and `http://localhost:3000` without clobbering. Shape:

```jsonc
{
  "https://primer.up.railway.app": {
    "tokenId": "8b3c…",        // server-side id, used by primer_logout to revoke
    "token": "primer_pat_…",
    "prefix": "abc12345",       // for display only
    "savedAt": "2026-06-05T…"
  },
  "http://localhost:3000": { … }
}
```

Reads/writes are scoped to the entry for `PRIMER_API_URL`. Writes are **atomic**: write to `tokens.json.tmp` (mode `0600`), `fsync`, `rename` over `tokens.json`. Prevents partial writes when two entry points race (in-agent `primer_login_status` and the standalone `primer-mcp login` CLI subcommand).

**Token resolution order:** `PRIMER_API_TOKEN` env → token-store entry for the current `PRIMER_API_URL` → none (unauthenticated; data tools error with `code: 'not_authenticated'` and tell the user to log in). The device-flow login writes the store entry for `PRIMER_API_URL`.

### Dev vs. prod base URLs

In **prod**, `AUTH_BASE_URL` on the API points at the public SPA origin (`https://primer.up.railway.app`); `verificationUri` resolves to `https://primer.up.railway.app/device`, which the React Router handles via the SPA fallback in `app.ts`. In **dev**, the API runs at `localhost:3000` but the SPA is served by Vite at `localhost:5173` (which proxies `/api/*` to :3000). Set `AUTH_BASE_URL=http://localhost:5173` so device-flow URLs render the SPA-served approval page. If `AUTH_BASE_URL` is unset, `/api/device/authorize` returns relative paths (`/device`) and the CLI prepends `PRIMER_API_URL` — works for prod-style same-origin setups, breaks the dev split-origin case (callers must explicitly set `AUTH_BASE_URL` in dev).

### Transport & registration

`StdioServerTransport`. Agents register:

```bash
claude mcp add primer \
  --env PRIMER_API_URL=https://primer.up.railway.app \
  -- npx -y @primer/mcp
```

No token in the registration — it's obtained interactively via the login flow.

### Login (device flow) — two entry points sharing the store

The login tools are **stateless** between calls: `primer_login` returns the `deviceCode` to the agent (along with the user-facing URL + code), and `primer_login_status` accepts the `deviceCode` as input. This way an MCP server restart mid-flow (Claude Code restarts MCPs fairly often) doesn't orphan the login — the agent already has the only piece of state it needs.

- **In-agent (MCP tools):**
  - `primer_login` — `POST /api/device/authorize` (with `clientLabel = os.hostname()` by default), return `{ deviceCode, userCode, verificationUri, expiresIn, interval }`. The tool result includes a fixed-shape user-facing instruction string the agent surfaces verbatim (see Section 5 on the strict format). The response intentionally **omits `verificationUriComplete`** so the agent doesn't accidentally show the pre-filled URL — that URL exists in the API response but the MCP layer drops it to enforce the "user types the code" UX.
  - `primer_login_status` — accepts `{ deviceCode }`; **long-polls internally**, calling `POST /api/device/token` with the server-recommended `interval` and respecting `slow_down`, up to a hard MCP-side timeout of **90 seconds** per invocation. Returns one of: `{ status: 'approved', tokenPrefix, expiresAt }` (after writing the store), `{ status: 'pending' }` (timed out before user approved — agent calls again), `{ status: 'denied' }`, `{ status: 'expired' }`, `{ status: 'error', code }`. The internal poll collapses what would otherwise be many round-trips between agent and MCP into one.
  - `primer_logout` — clears the local store entry for `PRIMER_API_URL` **and** calls `DELETE /api/tokens/:tokenId` to revoke server-side (the `tokenId` is stored alongside the secret per the schema above). Idempotent if the token is already revoked / missing.
- **From the CLI (`primer-mcp login` subcommand):** runs the full loop non-interactively for the user — prints the URL + code (does **not** open the browser automatically; the user pastes), auto-polls until approved/expired, writes the store. Shares the same atomic write path as the in-agent flow.

### Tool error contract

Every MCP tool error includes a machine-checkable `code` field so the skill can branch on it without string-matching messages. Codes:

| Code | Meaning |
|---|---|
| `not_authenticated` | No token in env or store, or the API returned 401. Skill triggers `primer_login`. |
| `forbidden` | API returned 403 (e.g., not the uploader of a document). Skill surfaces and asks the user. |
| `not_found` | API returned 404 (document/version id stale). |
| `bad_request` | API returned 400 (validation / size / format). Message carries server detail. |
| `rate_limited` | Reserved for future use; the device endpoints emit `slow_down` only. |
| `network` | Fetch failed before getting a response; transient, retryable. |
| `login_denied` / `login_expired` | Terminal login states surfaced by `primer_login_status`. |

`PrimerApiError` carries `{ code, message, status }`; tool handlers map it into the MCP error shape.

### Data tools

All return structured JSON + a readable text summary; API errors (401/403/404/400) map to clear messages (401 → "Not authenticated or token expired — run `primer_login`").

| Tool | Input | Maps to | Returns |
|---|---|---|---|
| `primer_whoami` | – | `GET /api/me` | `{ id, email, displayName }` |
| `primer_create_document` | `{ title, description?, content, format: "html"\|"markdown" }` | `POST /api/upload` | `{ documentId, versionId, url }` |
| `primer_add_version` | `{ documentId, content, format, versionNote? }` | `POST /api/documents/:id/versions` | `{ versionId, versionNumber, url }` |
| `primer_get_document` | `{ documentId }` | `GET /api/documents/:id` | document + `latestVersion` |
| `primer_list_versions` | `{ documentId }` | `GET /api/documents/:id/versions` | version list |
| `primer_get_comments` | `{ versionId }` **or** `{ documentId }` (→ latest version) | `GET /api/versions/:versionId/threads` | threads + comments, formatted for review |

`content` is inline (artifacts ≤10 MB). `primer_get_comments` groups by thread; **for each thread it emits the anchored selection text** — i.e., the literal quote from the document the comment is attached to (`selectorText` from the existing thread anchor, NOT the CSS path) — followed by open/resolved state and each non-deleted comment's author, body, and timestamps. Tombstoned comments render as `(deleted)`. The selection text is the part the agent uses to locate the corresponding source position; emitting only the CSS selector would force the agent to re-fetch and parse the rendered HTML.

### Internal modules

`src/client.ts` (`PrimerClient` + multipart + error mapping), `src/tokenStore.ts` (read/write/clear the store, env override), `src/deviceLogin.ts` (authorize/poll helpers, used by both the tool and the CLI subcommand), `src/format.ts` (pure comment formatter), `src/tools.ts` (zod schemas + handlers), `src/index.ts` (env, transport, `login` subcommand dispatch).

### Testing

Vitest, node env: client request shaping + error mapping (mocked `fetch`); token-store read/write/precedence (tmp dir); device-login poll-loop state machine (pending→slow_down→approved, expired, denied) against mocked fetch; comment formatter; tool handlers against a mocked client. Optional in-memory integration: boot `createApp` with a bearer-composed resolver, run a real `PrimerClient` over `app.request` for a create→add-version→get-comments round-trip.

### Supply chain

`@modelcontextprotocol/sdk` + `zod` must clear `minimumReleaseAge: 14 days` and `blockExoticSubdeps`, with no postinstall scripts. Pin versions ≥14 days old; regenerate + commit `pnpm-lock.yaml`.

---

## Section 5 — Agent skill (`primer`)

Checked into the repo at `.claude/skills/primer/SKILL.md` (dogfoodable + distributable). Workflow brain over the MCP tools.

### Frontmatter

```yaml
---
name: primer
description: >-
  Publish and iterate on LLM-generated HTML or Markdown artifacts in Primer.
  Use when the user wants to share an artifact at a stable URL, push a new
  version as they iterate, or pull reviewer comments/feedback on a version.
  Requires the @primer/mcp server; the skill walks the user through a one-time
  browser approval to obtain a token.
---
```

### Body (workflow)

1. **Auth preflight** — try `primer_whoami`. If the error has `code === 'not_authenticated'`, run the login flow: call `primer_login`, **show the user the verification URL + code using the strict format below**, then call `primer_login_status` (passing the `deviceCode` returned by `primer_login`). Re-poll if it returns `pending` (each call long-polls up to 90s server-side). Never print the token. Branch on `code`, not on message text.
2. **Create vs. iterate** — new artifact → `primer_create_document` (pick `format` from content/extension); **remember the `documentId`** in `.primer/document.json` so later turns target the same doc. Existing doc (file present or user names it) → `primer_add_version`.
3. **Share** — surface the returned `url` immediately.
4. **Iterate** — regenerate, `primer_add_version` with a concise `versionNote` ("fixed Y-axis scale").
5. **Gather feedback** — `primer_get_comments` (latest version by default); summarize open threads using the anchored selection text as the quote, propose/apply fixes, then push a new version whose note references the addressed feedback.

### Strict login-prompt format

When relaying `primer_login`'s result to the user, the skill outputs exactly this shape, on its own with no surrounding prose:

```
Open this URL in your browser:
  <verificationUri>

Then type this code on the page:
  <userCode>
```

No markdown links, no code-fence wrappers around the whole thing, no extra suggestions. The user's eye lands on the URL and code without parsing a paragraph.

### `.primer/document.json` location

The file lives in `process.cwd()` of the agent invocation, **not** the repo root. If the user runs `claude` from `~/work/charts/` and asks the agent to publish `report.html`, the file is `~/work/charts/.primer/document.json`. The skill must `mkdir -p .primer` before writing. Shape:

```jsonc
{ "documentId": "…", "lastVersionId": "…", "url": "https://primer…/d/…", "savedAt": "…" }
```

If the file exists and references a document the API returns 404 for (deleted on the server), the skill prompts the user before creating a new one — never silently overwrites.

### Conventions captured

`.primer/document.json` persistence (location + 404 handling); format selection (`.md`/`.markdown` → markdown, else html) + 10 MB limit; the two upload mutations Primer makes (`<iframe>` / `<meta refresh>` stripped); never echo the token; the strict login-prompt format; the MCP error `code` taxonomy and how the skill branches on it; what to tell the user if the MCP server isn't configured (`claude mcp add primer …` + `PRIMER_API_URL`). A `reference.md` holds full tool I/O and the login sequence (progressive disclosure).

---

## Section 6 — Security

- **Device flow — phishing posture.** The dominant attack on device-grant systems (the GitHub/Google class of socially-engineered approvals): attacker initiates `POST /api/device/authorize`, social-engineers a Polygon employee to click `verificationUriComplete`, victim clicks Approve, attacker polls and pockets a `primer_pat_…` for the victim's account. The mitigations stack:
  1. **The approval page does not pre-fill `user_code` from `?code=`.** The user must read the code from their terminal and type it on the page. This is the single highest-leverage change: an attacker who supplies a pre-filled URL cannot also supply the code the victim sees in their own terminal.
  2. **Approval page surfaces request metadata** fetched via `GET /api/device/pending`: the `clientLabel` (clearly labeled "claimed by the requesting tool, not verified"), `requester_ip`, and "started N minutes ago". A request from an unfamiliar IP / claiming an unfamiliar source is legible to a security-aware user.
  3. **`user_code`** has ~40 bits of entropy in an unambiguous alphabet, single-use, 10-minute window. Guessing is infeasible even without a general rate limiter.
  4. **`verificationUriComplete`** stays in the API response (RFC compatibility, QR-code tooling) but the MCP server **omits it from `primer_login`'s output** so the agent cannot accidentally show it; the user sees only `verificationUri` + `userCode`.
- **Token at rest.** sha-256 hex; plaintext returned exactly once (on the first post-approval poll). Indexed point-lookup, no per-char compare.
- **Token expiry.** Device-issued tokens get a default 90-day expiry (Section 2). Re-running login is cheap and replaces the stored token in-place.
- **Revoke + expiry** first-class; validation query rejects both; revoked rows purged after 30 days, device rows after 1 day. `primer_logout` revokes server-side via `DELETE /api/tokens/:tokenId` in addition to clearing the local store.
- **CSRF.** Bearer requests and the public device endpoints are exempt (no ambient credential); exemption keyed off `authMethod === 'bearer'` and the shared `PUBLIC_PATHS` set (Section 3). No permissive CORS — reaffirmed.
- **No bearer override of session identity.** `composeResolvers(bearer, …)` short-circuits on the first non-null match, so a header-based mock identity (`X-Mock-User-Id`) is **never consulted** when a bearer is present. Explicit test coverage.
- **Authority.** A token == its owner; no scopes in v1 (Section 7). A token can manage tokens for its own user; flagged for the v2 scope model.
- **Secrets hygiene.** `primer_pat_` prefix is greppable for push-protection/secret-scanning. API request logger logs `user_id` only; token/device routes never log secrets, hashes, or response bodies. **Hard rule:** `/api/device/token` response bodies are never serialized to any log sink, current or future — a unit test asserts the route handler does not call `logger.*` with the response payload, and any logger interceptor that would dump bodies must explicitly exclude this path. The MCP server never logs the token; the store file is `0600`.
- **Atomic token-store writes.** The MCP store uses temp-file write + `rename` (atomic on POSIX) so a crash or concurrent writer (CLI `login` subcommand racing the in-agent flow) cannot leave a half-written `tokens.json`.
- **Mock mode.** Bearer + device flow work under `AUTH_MODE=mock` (tokens/approvals resolve to `mock-user-1`), enabling local end-to-end testing without Okta. Mock mode stays forbidden in production (existing `index.ts` guard).

---

## Section 7 — Out of scope / deferred

- **Manual web-UI token minting (`POST /api/tokens`).** Removed from v1 — the device flow is the only mint path so every `api_tokens` row corresponds to an explicit Okta-authenticated device approval. Re-introduce in v2 alongside the scope model, when CI/long-lived tokens need a different shape.
- Token **scopes** (read-only, per-document). v2.
- **Remote HTTP MCP transport** on the API. Future phase (D2).
- **Full OAuth authorization-code / client registry / refresh tokens.** Device grant only.
- **Agent-authored comments.** Fetch-only in v1.
- **General rate limiting / per-token usage analytics.**
- **Public npm publish of `@primer/mcp`.** v1 runs via `npx`/internal registry. When published, `claude mcp add` invocations should pin a version (`npx -y @primer/mcp@<pinned>`).
- **Standalone `primer` CLI binary** beyond the `@primer/mcp` `login` subcommand.
- **Raw-JSON upload body.** Multipart reuse only.

---

## Decision log

| # | Topic | Decision |
|---|---|---|
| D1 | Token **issuance** | **OAuth 2.0 Device Authorization Grant (RFC 8628)** is the **only** mint path in v1: agent initiates, user approves in-browser (reusing the Okta session), CLI polls and auto-receives a `primer_pat_…` token. Manual web minting is deferred (see D19). |
| D2 | MCP transport | Local **stdio** package (`@primer/mcp`). Remote HTTP deferred. |
| D3 | Steady-state auth | Compose `bearerResolver` ahead of okta/mock; record `authMethod`; CSRF exempts bearer requests + shared `PUBLIC_PATHS` (D18). No data-route changes. |
| D4 | Upload over API | Reuse multipart endpoints; MCP builds `FormData`. No raw-JSON path. |
| D5 | MCP content input | Inline `content` string. File-path input deferred. |
| D6 | Token scopes | Full-user authority in v1; scopes v2. |
| D7 | Skill location | In-repo `.claude/skills/primer/`. Orchestrates tools incl. login. |
| D8 | Comment fetch | Reuse `GET /api/versions/:versionId/threads`; MCP formats for review. Fetch-only. |
| D9 | Package placement | `apps/mcp` (runnable). |
| D10 | Token at first poll | Token minted on first post-approval poll, returned once, never stored in plaintext. Approval only flips status + sets user. |
| D11 | Token store | `@primer/mcp` persists to `~/.config/primer/tokens.json` (`0600`), **keyed by `PRIMER_API_URL`**, atomic temp+rename writes; each entry holds `{ tokenId, token, prefix, savedAt }`. `PRIMER_API_TOKEN` env overrides; `PRIMER_TOKEN_FILE` relocates the file. |
| D12 | Login entry points | Both in-agent MCP tools (`primer_login`/`primer_login_status`) and a `primer-mcp login` CLI subcommand, sharing the store. |
| D13 | Phishing hardening | Approval page **does not pre-fill the user code from `?code=`** — user types it from their terminal. `verificationUriComplete` is dropped from the MCP `primer_login` result (kept in the API response for RFC compatibility). Approval page surfaces `clientLabel` (untrusted), `requester_ip`, and request age via `GET /api/device/pending`. |
| D14 | Device token expiry | Device-issued tokens default to `now + 90 days`. Re-login is cheap and replaces the stored entry. Nullable `expires_at` stays for future flows. |
| D15 | Stateless login tools | `primer_login` returns `deviceCode` to the agent; `primer_login_status` accepts it as input. Survives MCP process restarts mid-login. |
| D16 | Long-polling login status | `primer_login_status` polls internally up to 90 s honoring server `interval`/`slow_down`, returning a terminal state or `pending` for re-invocation. Collapses agent ↔ MCP round-trips. |
| D17 | MCP error taxonomy | Tools return a machine-checkable `code` (`not_authenticated` / `forbidden` / `not_found` / `bad_request` / `rate_limited` / `network` / `login_denied` / `login_expired`). Skill branches on `code`, never on message text. |
| D18 | Centralized `PUBLIC_PATHS` | The public-path allowlist lives in `middleware/auth.ts` and is imported by `csrfMiddleware`. One source of truth; CSRF + auth exemptions cannot drift. |
| D19 | Manual mint removed from v1 | `POST /api/tokens` is out for v1. Every `api_tokens` row corresponds to an Okta-authenticated device approval. Re-introduce alongside the v2 scope model. |
| D20 | No log of `/api/device/token` response bodies | Hard rule with explicit unit test. Future debug interceptors must skip this path. |
| D21 | `.primer/document.json` location | Lives in `process.cwd()` of the agent invocation (not the repo root). Skill creates `.primer/` on demand and prompts before overwriting when the recorded document id is 404. |
