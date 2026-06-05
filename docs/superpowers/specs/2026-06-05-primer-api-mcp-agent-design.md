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
       │     GET /device?code=WDJB-MZHT  →  Approve                │  COOKIE: GET /device (SPA page) │
       │                                   POST /api/device/approve │          /api/device/approve    │
       │                                                           │          /api/device/deny       │
       │  4. POST /api/device/token (poll, every `interval`s)      │                                 │
       │  ◀──── 200 { token: primer_pat_… }  (minted on approval)  │  mints api_tokens row           │
       │                                                           │                                 │
       │  5. store token in ~/.config/primer/token.json           │                                 │
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

A bearer token is not an ambient credential, so a cross-site page cannot forge a bearer-authed request. `csrfMiddleware` therefore **skips the check when `authMethod === 'bearer'`** (keyed off the winning resolver, not raw header presence). The unauthenticated device endpoints (`/api/device/authorize`, `/api/device/token`) carry no cookie either and are CSRF-exempt as well. The "no permissive CORS" invariant from `csrf.ts` still holds and is reaffirmed.

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
    clientLabel: text('client_label'),                   // optional hint from the CLI (hostname)
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

**Token issuance is deferred to first successful poll.** On approval we only set `status='approved'` + `user_id`. When the CLI's poll arrives and the row is approved, the server *then* `generateToken()`, inserts the `api_tokens` row (`name = clientLabel ?? 'device login'`), returns the **plaintext once**, and marks the device row `consumed`. This way the plaintext exists only in that one response and is never stored.

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
| `POST` | `/api/device/authorize` | **none** (public) | Start the flow. Optional body `{ clientLabel? }`. Generates `device_code` + `user_code`, stores a pending row, returns `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }`. |
| `POST` | `/api/device/token` | **none** (the `device_code` is the credential) | Poll. Body `{ deviceCode }`. Returns one of: `authorization_pending` (400), `slow_down` (400, if polled faster than `interval`), `expired_token` (400), `access_denied` (400), or **200 `{ token, tokenPrefix, expiresAt }`** on the first poll after approval (then the row is `consumed`; further polls → `invalid_grant`). |
| `GET` | `/device` | cookie/Okta (page) | The browser approval **page** (served by the SPA). `?code=WDJB-MZHT` pre-fills the code. If the user isn't signed in, the existing middleware redirects through Okta and back. |
| `POST` | `/api/device/approve` | cookie/Okta + CSRF | Body `{ userCode }`. Looks up a pending, non-expired row; sets `status='approved'`, `user_id = current user`. Returns the resolved `clientLabel` for display/confirmation. |
| `POST` | `/api/device/deny` | cookie/Okta + CSRF | Body `{ userCode }`. Sets `status='denied'`. |

`/api/device/authorize` and `/api/device/token` are added to the middleware **public-path allowlist** and are **CSRF-exempt** (no cookie involved; the device/user codes are the security boundary). Error bodies follow RFC 8628 naming so the shape is familiar.

### Token-management endpoints (`apps/api/src/routes/tokens.ts`)

For visibility and revocation of device-issued (and any manually-minted) tokens.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/tokens` | any authenticated identity | List the caller's tokens (metadata only — never the secret): `{ id, name, tokenPrefix, createdAt, lastUsedAt, expiresAt, revokedAt }[]`. |
| `DELETE` | `/api/tokens/:id` | owner only | Revoke (set `revoked_at`). 404 if not found/owned. Idempotent. |
| `POST` | `/api/tokens` | any authenticated identity | **Optional/secondary.** Manually mint a token (`{ name, expiresInDays? }`) → returns the plaintext once. Useful for CI/scripts; the device flow is the primary path for interactive agents. |

### DTOs (`packages/shared/src/api.ts`, append)

```ts
export interface DeviceAuthorizeResponse {
  deviceCode: string; userCode: string;
  verificationUri: string; verificationUriComplete: string;
  expiresIn: number; interval: number;
}
export interface DeviceTokenSuccess { token: string; tokenPrefix: string; expiresAt: string | null; }
export interface DeviceTokenPending { error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant'; }

export interface ApiTokenSummary {
  id: string; name: string; tokenPrefix: string;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
}
export interface ApiTokensListResponse { tokens: ApiTokenSummary[]; }
export interface CreateTokenRequest { name: string; expiresInDays?: number; }
export interface CreateTokenResponse extends ApiTokenSummary { token: string; }
```

### Resolver & middleware

- `makeBearerResolver()` — `Authorization: Bearer primer_pat_…` → hash → validation query → throttled `last_used_at` touch → `c.set('authMethod','bearer')`.
- `composeResolvers(...)` — first non-null wins. Composed at boot in **both** auth modes (so the flow is testable under `AUTH_MODE=mock`).
- `AppVariables.authMethod?: 'bearer' | 'cookie' | 'mock'`; okta/mock resolvers set their values.
- `csrfMiddleware` exempts `authMethod === 'bearer'` and the two public device endpoints.

### Upload over the API

`POST /api/upload` and `POST /api/documents/:docId/versions` accept multipart form-data (`file` part + `title`/`description`/`versionNote`). The MCP server builds this with `FormData` + `Blob` — **no server change needed**.

---

## Section 4 — MCP server (`apps/mcp`, package `@primer/mcp`)

A standalone runnable workspace package (consistent with `apps/api`/`apps/web`; `packages/*` stays for libraries). Stdio MCP server with a built-in login flow.

### Configuration & token store

| Var | Required | Meaning |
|---|---|---|
| `PRIMER_API_URL` | yes | Base URL, e.g. `https://primer.up.railway.app` or `http://localhost:3000` |
| `PRIMER_API_TOKEN` | no | Explicit token (CI/override). If unset, the server uses the **token store**. |
| `PRIMER_TOKEN_FILE` | no | Override for the token store path |

**Token resolution order:** `PRIMER_API_TOKEN` env → token-store file (default `~/.config/primer/token.json`, mode `0600`) → none (unauthenticated; data tools error and tell the user to log in). The device-flow login writes the store file.

### Transport & registration

`StdioServerTransport`. Agents register:

```bash
claude mcp add primer \
  --env PRIMER_API_URL=https://primer.up.railway.app \
  -- npx -y @primer/mcp
```

No token in the registration — it's obtained interactively via the login flow.

### Login (device flow) — two entry points sharing the store

- **In-agent (MCP tools):**
  - `primer_login` — `POST /api/device/authorize`, stash the `device_code` in the server process, return `{ verificationUri, verificationUriComplete, userCode, expiresIn }` plus a text instruction for the agent to relay ("Open <url> and click Approve; the code is WDJB-MZHT").
  - `primer_login_status` — poll `/api/device/token` once (respecting `interval`); return `pending` / `approved` / `denied` / `expired`. On `approved`, write the token to the store; subsequent data tools just work. (The agent shows the URL, waits for the user, then calls this — or calls it a few times.)
  - `primer_logout` — clear the stored token (and optionally call `DELETE /api/tokens/:id` if the id is known).
- **From the CLI (`primer-mcp login` subcommand):** runs the full loop non-interactively for the user — prints the URL + code (optionally opens the browser), auto-polls until approved/expired, writes the store. For users who prefer a one-shot terminal command outside the agent.

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

`content` is inline (artifacts ≤10 MB). `primer_get_comments` groups by thread and renders the anchored selection, open/resolved state, and each comment's author/body/timestamps, so the agent can act on feedback.

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

1. **Auth preflight** — try `primer_whoami`. If it errors with "not authenticated", run the login flow: call `primer_login`, **show the user the verification URL + code**, ask them to open it and click Approve, then call `primer_login_status` (re-poll a few times until approved/expired). Never print the token.
2. **Create vs. iterate** — new artifact → `primer_create_document` (pick `format` from content/extension); **remember the `documentId`** in `.primer/document.json` so later turns target the same doc. Existing doc (file present or user names it) → `primer_add_version`.
3. **Share** — surface the returned `url` immediately.
4. **Iterate** — regenerate, `primer_add_version` with a concise `versionNote` ("fixed Y-axis scale").
5. **Gather feedback** — `primer_get_comments` (latest version by default); summarize open threads, propose/apply fixes, then push a new version whose note references the addressed feedback.

### Conventions captured

`.primer/document.json` persistence; format selection + 10 MB limit; the two upload mutations Primer makes (`<iframe>` / `<meta refresh>` stripped); never echo the token; what to tell the user if the MCP server isn't configured (`claude mcp add primer …` + `PRIMER_API_URL`). A `reference.md` holds full tool I/O and the login sequence (progressive disclosure).

---

## Section 6 — Security

- **Device flow.** Approval is an explicit, CSRF-protected click by an Okta-authenticated user; the page displays the `user_code` and "a command-line tool is requesting access to your Primer account as <you@polygon>" so a socially-engineered approval is at least legible. `user_code` is short-lived (10 min), single-use, high-enough entropy for the window. `device_code` is 256-bit and stored hashed. Poll `interval` is enforced (`slow_down`). `verification_uri_complete` is a convenience pre-fill, not an auto-approve.
- **Token at rest.** sha-256 hex; plaintext returned exactly once (on the first post-approval poll, or on manual mint). Indexed point-lookup, no per-char compare.
- **Revoke + expiry** first-class; validation query rejects both; revoked rows purged after 30 days, device rows after 1 day.
- **CSRF.** Bearer requests and the two public device endpoints are exempt (no ambient credential); exemption keyed off the winning resolver. No permissive CORS — reaffirmed.
- **Authority.** A token == its owner; no scopes in v1 (Section 7). A token can manage tokens for its own user; flagged for the v2 scope model.
- **Secrets hygiene.** `primer_pat_` prefix is greppable for push-protection/secret-scanning. API request logger logs `user_id` only; token/device routes never log secrets or hashes. The MCP server never logs the token; the store file is `0600`.
- **Mock mode.** Bearer + device flow work under `AUTH_MODE=mock` (tokens/approvals resolve to `mock-user-1`), enabling local end-to-end testing without Okta. Mock mode stays forbidden in production (existing `index.ts` guard).

---

## Section 7 — Out of scope / deferred

- Token **scopes** (read-only, per-document). v2.
- **Remote HTTP MCP transport** on the API. Future phase (D2).
- **Full OAuth authorization-code / client registry / refresh tokens.** Device grant only.
- **Agent-authored comments.** Fetch-only in v1.
- **General rate limiting / per-token usage analytics.**
- **Public npm publish of `@primer/mcp`.** v1 runs via `npx`/internal registry.
- **Standalone `primer` CLI binary** beyond the `@primer/mcp` `login` subcommand.
- **Raw-JSON upload body.** Multipart reuse only.

---

## Decision log

| # | Topic | Decision |
|---|---|---|
| D1 | Token **issuance** | **OAuth 2.0 Device Authorization Grant (RFC 8628)**: agent initiates, user approves in-browser (reusing the Okta session), CLI polls and auto-receives a `primer_pat_…` token. Manual web minting kept as an optional secondary path. |
| D2 | MCP transport | Local **stdio** package (`@primer/mcp`). Remote HTTP deferred. |
| D3 | Steady-state auth | Compose `bearerResolver` ahead of okta/mock; record `authMethod`; CSRF exempts bearer + device endpoints. No data-route changes. |
| D4 | Upload over API | Reuse multipart endpoints; MCP builds `FormData`. No raw-JSON path. |
| D5 | MCP content input | Inline `content` string. File-path input deferred. |
| D6 | Token scopes | Full-user authority in v1; scopes v2. |
| D7 | Skill location | In-repo `.claude/skills/primer/`. Orchestrates tools incl. login. |
| D8 | Comment fetch | Reuse `GET /api/versions/:versionId/threads`; MCP formats for review. Fetch-only. |
| D9 | Package placement | `apps/mcp` (runnable). |
| D10 | Token at first poll | Token minted on first post-approval poll, returned once, never stored in plaintext. Approval only flips status + sets user. |
| D11 | Token store | `@primer/mcp` persists to `~/.config/primer/token.json` (`0600`); `PRIMER_API_TOKEN` env overrides; `PRIMER_TOKEN_FILE` relocates. |
| D12 | Login entry points | Both in-agent MCP tools (`primer_login`/`primer_login_status`) and a `primer-mcp login` CLI subcommand, sharing the store. |
