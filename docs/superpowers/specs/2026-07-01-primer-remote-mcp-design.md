# Primer — Remote MCP for Claude Web & Desktop (design spec)

**Status:** draft, ready for review
**Date:** 2026-07-01
**Author:** Taylan Pince (with Claude)
**Issue:** [#30 — Improve MCP server so it works with Claude Web and Desktop](https://github.com/0xPolygon/primer/issues/30)
**Predecessor spec:** [Primer API / stdio MCP / agent skill](./2026-06-05-primer-api-mcp-agent-design.md)

## Goal

Let Claude Web and Claude Desktop connect to Primer as a first-class MCP connector — full auth flow in the browser, no CLI required, and one turn to go from "here's a Primer link, what do people think?" to a new HTML doc published back into Primer.

Concretely, after this ships:

> A user pastes `https://primer-polygon.up.railway.app/mcp` into Claude Web's connector dialog. They click through an OAuth consent screen backed by their existing Okta session. Claude can then read any Primer document the user has access to (by document ID **or** by pasting a raw Primer URL), read comments on a version, and create/update documents — all without downloading and re-uploading HTML by hand.

The existing CLI path (stdio server at `apps/mcp`, device-authorization flow on the API) is **untouched**. Migrating CLI clients to the remote transport is out of scope; the two paths co-exist.

## Non-goals

- **CLI migration.** `@polygonlabs/primer-mcp` and `POST /api/device/*` stay as-is. A follow-up spec can consolidate.
- **Scope splitting.** Single `primer` scope covering read + write. Splitting into `primer:read` / `primer:write` is a later change with a concrete second consumer.
- **JWT access tokens.** Opaque bearer tokens only; DB lookup on each request. Short TTL keeps DB load bounded and sidesteps key rotation surface.
- **Client secrets.** All OAuth clients are public + PKCE-only (per OAuth 2.1 for browser-based apps).
- **Admin UI for revoking tokens / consents.** SQL for now. A user-facing "connected apps" page is a follow-up.
- **Broader read surface.** No `primer_list_my_documents` or dashboard-style tools in this scope.
- **Per-request rate limits beyond the OAuth endpoints.** MCP tool calls rely on the same limits as the underlying REST endpoints they call into.

---

## Section 1 — Architecture

A new **remote MCP surface** lives inside the existing `apps/api` Hono app at `/mcp`, exposed as an OAuth 2.1-protected resource. A minimal **OAuth 2.1 authorization server** is added to the same app, backed by Primer's existing Okta-federated session. Both surfaces reuse the app's DB, storage, and user model — no new deploy target, no new service.

```
Claude Web / Desktop
        │
        │  1. /.well-known/oauth-protected-resource   (metadata)
        │  2. /.well-known/oauth-authorization-server (metadata)
        │  3. POST /oauth/register       (RFC 7591 DCR — redirect-URI allowlist)
        │  4. GET  /oauth/authorize      (redirects into Okta if no primer_sid;
        │                                 then shows consent screen — or skips
        │                                 it if prior consent exists)
        │  5. POST /oauth/consent        (form action; issues auth code + PKCE)
        │  6. POST /oauth/token          (code → access+refresh; refresh grant)
        │  7. POST /mcp     Authorization: Bearer <access>
        ▼
   Streamable HTTP MCP transport (stateless)
        │
        ├─ primer_whoami
        ├─ primer_get_document   (id OR URL)
        ├─ primer_list_versions
        ├─ primer_get_comments
        ├─ primer_create_document
        ├─ primer_add_version
        └─ primer_resolve_url    (URL → { documentId, versionId? })
        ▼
   Existing service layer (documents, versions, comments, uploads)
```

**Federation:** `/oauth/authorize` piggybacks on the existing Primer session cookie (`primer_sid`, Okta-backed). No cookie → redirect to `/auth/okta/start?return_to=…` → back to `/oauth/authorize` after Okta round-trip.

**Transport mode:** stateless Streamable HTTP. No `Mcp-Session-Id` state, no notifications, no subscriptions. Each MCP request is a self-contained POST.

## Section 2 — Components (new code, by file)

Everything under `apps/api/src/`.

### OAuth server (`auth/oauth/`)

- `metadata.ts` — builds `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` responses. Computed once from env at boot.
- `clients.ts` — DB access for `oauth_clients`. Redirect-URI allowlist enforcement.
- `authorize.ts` — GET `/oauth/authorize`. Validates client + query params, redirects to Okta if no `primer_sid`, else renders a small server-rendered HTML consent page (plain Hono `c.html(...)`, not the SPA — the SPA isn't guaranteed to be same-origin with the session cookie in local-dev, and we want the consent screen to live at the same origin as the OAuth AS). Skips to code issuance if a prior consent row exists.
- `consent.ts` — POST `/oauth/consent`. Validates CSRF + session, records the consent row, mints an auth code, redirects to `redirect_uri` with `code` + `state`.
- `token.ts` — POST `/oauth/token`. Handles `grant_type=authorization_code` (with PKCE verifier) and `grant_type=refresh_token` (with rotation + reuse detection).
- `register.ts` — POST `/oauth/register`. RFC 7591 with redirect-URI allowlist.
- `revoke.ts` — POST `/oauth/revoke`. RFC 7009. Never errors on unknown tokens.
- `bearer.ts` — resolver for OAuth access tokens, plugged into the existing auth resolver chain **before** the current PAT bearer resolver. Falls through if the token isn't in `oauth_access_tokens`.

### MCP transport (`mcp/`)

- `transport.ts` — mounts `Streamable HTTP` server transport at `/mcp` in stateless mode. Adds `WWW-Authenticate: Bearer resource_metadata=<url>` on 401 responses so Claude Web knows where to discover metadata.
- `tools.ts` — the seven tools listed in Section 1. Handlers call the existing service layer directly (not via HTTP hop).
- `urlResolve.ts` — parses a Primer URL to `{ documentId, versionId? }`. Used by `primer_resolve_url` and by `primer_get_document`'s URL-mode input.

### Wiring

- `app.ts` — registers OAuth routes, MCP transport, `.well-known` handlers.
- `middleware/auth.ts` — resolver chain gains the OAuth bearer branch before the existing PAT bearer branch.
- `packages/shared/schema.ts` — five new tables (Section 4).

### Unchanged

`apps/mcp/*`, `apps/api/src/routes/device.ts`, `apps/api/src/routes/tokens.ts`, and the `api_tokens` table are untouched.

### Tests

Colocated `*.test.ts` per file following the existing pattern (Section 7).

## Section 3 — Data flow

### A. First-time connect (Claude Web adds Primer as a connector)

1. User pastes `https://primer-polygon.up.railway.app/mcp` into Claude Web's connector dialog.
2. Claude Web fetches `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
3. Claude Web POSTs to `/oauth/register` with metadata (`redirect_uris`, `client_name`, `grant_types`, `token_endpoint_auth_method: 'none'`). The allowlist accepts it. Server returns a fresh `client_id` and stores the client row.
4. Claude Web opens `/oauth/authorize?client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&scope=primer` in the user's browser.
5. Server checks `primer_sid`:
   - Present + valid → jump to step 6.
   - Missing/invalid → 302 to `/auth/okta/start?return_to=<the /oauth/authorize URL>`. User completes Okta, lands back at `/oauth/authorize`.
6. Server looks up an existing consent row for `(user_id, client_id)`:
   - Found → skip form; mint code + redirect (step 8).
   - Not found → render consent HTML ("An app calling itself Claude wants full access to your Primer documents. [Allow] [Deny]").
7. User clicks Allow → POST `/oauth/consent` with CSRF token. Server records the consent row.
8. Server generates a random auth code, stores its sha256 hash with `code_challenge`, `redirect_uri`, `scopes`, `user_id`, `client_id`, and a 5-minute `expires_at`. Redirects the browser to `redirect_uri?code=<code>&state=<state>`.
9. Claude Web POSTs `/oauth/token` with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`. Server validates PKCE (`SHA256(code_verifier) === code_challenge`) and `redirect_uri` binding, marks the code consumed in the same transaction, mints access (1h) + refresh (30d rolling), returns them.
10. Claude Web is now connected.

### B. Tool call

1. Claude Web POSTs `/mcp` with `Authorization: Bearer <access>` and a JSON-RPC request (`tools/list`, `tools/call`, …).
2. `middleware/auth.ts` OAuth bearer resolver: sha256 the token, look up in `oauth_access_tokens`, check `expires_at`, load user, set `c.var.user`.
3. Streamable HTTP transport dispatches to the tool handler.
4. Handler calls the same service functions the REST routes use — no HTTP hop.

### C. Access token refresh

1. Access expires → Claude Web POSTs `/oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id`.
2. Server sha256s the token, looks up in `oauth_refresh_tokens`, validates `client_id` binding.
3. If `rotated_at IS NOT NULL` on the presented token → **reuse detected**. In one transaction: update every row where `family_id = ?` to `revoked_at = now()`, return `invalid_grant`, log a warning with `family_id` / `client_id` / `user_id` (no token material).
4. Otherwise: mint new access + new refresh (same `family_id`), mark the presented refresh `rotated_at = now()`, return the new pair.

**Concurrent-refresh caveat.** If Claude Web retries a refresh mid-flight (e.g. its first `/token` call timed out but reached the server), the second request presents an already-rotated token and triggers reuse detection. The user has to reconnect. This is the standard OAuth 2.1 rotation tradeoff — accepting it in exchange for automatic leaked-token detection.

### D. Revocation / disconnect

- User disconnects Claude Web → Claude Web POSTs `/oauth/revoke` with the refresh token → server marks the family revoked. On next tool call the OAuth bearer resolver will 401.
- Access tokens naturally expire within 1 hour; no separate access-token revocation needed for the disconnect path.

## Section 4 — Data model

Five new tables in `packages/shared/schema.ts`. All primary keys are `uuid v7`.

### `oauth_clients` — DCR-registered clients

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `client_id` | text | public, unique, 32-char random |
| `client_name` | text | from DCR metadata; shown on consent screen |
| `redirect_uris` | jsonb | array; validated against allowlist at registration |
| `grant_types` | jsonb | `['authorization_code', 'refresh_token']` for our clients |
| `token_endpoint_auth_method` | text | `'none'` — public clients, PKCE-only |
| `created_at` | timestamptz | |

No client-secret column.

### `oauth_consents` — remembered per (user, client)

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `user_id` | uuid | fk users |
| `client_id` | text | fk `oauth_clients.client_id` |
| `scopes` | jsonb | array of granted scopes |
| `created_at` / `updated_at` | timestamptz | |

Unique index on `(user_id, client_id)`. Deleted when the user disconnects.

### `oauth_authorization_codes` — short-lived (5 min)

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `code_hash` | bytea | sha256 of the raw code |
| `user_id` | uuid | fk |
| `client_id` | text | fk |
| `redirect_uri` | text | exact match at `/token` |
| `code_challenge` | text | PKCE |
| `code_challenge_method` | text | `'S256'` only |
| `scopes` | jsonb | |
| `expires_at` | timestamptz | 5min after issue |
| `consumed_at` | timestamptz | nullable — single-use gate |

### `oauth_access_tokens` — 1 h

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `token_hash` | bytea | sha256, indexed |
| `user_id` | uuid | |
| `client_id` | text | |
| `scopes` | jsonb | |
| `expires_at` | timestamptz | |
| `created_at` | timestamptz | |

### `oauth_refresh_tokens` — 30 d rolling, rotation-reuse detection

| column | type | notes |
|---|---|---|
| `id` | uuid | pk |
| `family_id` | uuid | groups the rotation chain |
| `token_hash` | bytea | sha256, indexed |
| `user_id` | uuid | |
| `client_id` | text | |
| `scopes` | jsonb | |
| `expires_at` | timestamptz | |
| `rotated_at` | timestamptz | nullable — set when successor is minted |
| `revoked_at` | timestamptz | nullable — set when family is nuked |

Reuse-detection rule: presenting a token with `rotated_at IS NOT NULL` sets `revoked_at = now()` on every row sharing its `family_id` and returns `invalid_grant`.

## Section 5 — Error handling

### OAuth surface (RFC 6749 / 7591 / 7009)

| Endpoint | Error cases |
|---|---|
| `/oauth/register` | `invalid_redirect_uri` (not in allowlist), `invalid_client_metadata` (missing/bad fields) |
| `/oauth/authorize` | Invalid params → 302 back to `redirect_uri` with `error=invalid_request` / `unauthorized_client` / `access_denied` (when user clicks Deny). Only render an error page when `redirect_uri` itself is untrusted. |
| `/oauth/token` | `invalid_grant` (bad/consumed code, PKCE mismatch, refresh reuse detected — also nukes family), `invalid_client` (unknown client_id), `invalid_request` (missing params), `unsupported_grant_type` |
| `/oauth/revoke` | Never errors on unknown tokens (RFC 7009 returns 200). |

### MCP surface (`PrimerErrorCode` taxonomy)

Returned as `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] }`:

- `not_authenticated` — bearer missing / invalid / expired. HTTP layer also sets `WWW-Authenticate: Bearer resource_metadata=<url>` so Claude Web knows where to refresh.
- `forbidden` — token valid but resource isn't the user's.
- `not_found`, `bad_request`, `rate_limited`, `network`.

### URL-resolver specifics

`primer_resolve_url` and `primer_get_document`'s URL-mode return:
- `bad_request` with `message: 'not a Primer URL'` if the input doesn't parse as a Primer URL.
- `not_found` if the parsed slug/id doesn't resolve to a live document.

### Refresh-token reuse

Returns `invalid_grant`. In the same transaction the whole family is revoked. Logs a warning with `family_id`, `client_id`, `user_id` — never token material.

## Section 6 — Security posture

### Threat model

- **Phishing via third-party DCR.** Redirect-URI allowlist on `/oauth/register` (Claude Web + Desktop suffixes + `http://127.0.0.1` for local dev). Adding to the allowlist requires a code change in review.
- **Leaked access token.** 1h TTL caps blast radius. Stored hashed (sha256); raw tokens exist only in the client and in the `/oauth/token` response body.
- **Leaked refresh token.** Rotation with reuse detection: any replay of a rotated token nukes the whole family and forces re-consent. Refresh tokens hashed at rest.
- **Auth-code interception.** PKCE S256 mandatory. `code_verifier` bound to `code_challenge` at authorize-time and checked at token-time. Codes single-use via `consumed_at` gate in a transaction.
- **Open redirect via `redirect_uri` mismatch.** `/oauth/authorize` validates `redirect_uri` against the client's registered set before rendering anything; `/oauth/token` requires exact match.
- **CSRF on the consent form.** POST `/oauth/consent` is protected by the existing `csrfMiddleware`. The OAuth `state` param round-trips through the full `/authorize → /consent → redirect` chain.
- **Session fixation across Okta redirect.** `return_to` for `/auth/okta/start` is same-origin — the `/oauth/authorize` URL passes that check.
- **Consent-screen spoofing.** The DCR-provided `client_name` is shown as untrusted content: "An app calling itself X wants access." Never rendered as chrome-level trust.
- **Rate limits.** The codebase has no general rate-limit middleware today (only endpoint-specific throttling like the device-flow `interval`). This spec adds a small per-IP token-bucket middleware — in-memory, sized for a single Railway instance — applied to `/oauth/authorize`, `/oauth/token`, and `/oauth/register`. Bucket sizes and refill rates are picked to make brute-forcing auth codes / probing `client_id`s infeasible without impacting a legitimate connector setup.

### Explicit non-negotiables

- All bearer tokens (access, refresh, auth code) stored sha256-hashed at rest. Raw values never logged, never included in error messages, never returned in any response other than the one that mints them.
- PKCE required. No `plain` challenge method accepted.
- Public clients only. No client secrets.
- Single-use auth codes enforced by transactional `consumed_at` update.

## Section 7 — Testing

Vitest, colocated `*.test.ts` per existing pattern. Tests run against a real Postgres from the existing test setup — no auth-layer mocking.

### OAuth server tests (`auth/oauth/*.test.ts`)

- **DCR:** valid registration → `client_id` returned; unknown redirect URI → `invalid_redirect_uri`; missing fields → `invalid_client_metadata`.
- **`/authorize`:** no session → 302 to `/auth/okta/start` with correct `return_to`; valid session, no consent → consent HTML rendered; valid session + prior consent → auth code + redirect (no consent form); unknown `redirect_uri` → error page (not redirected).
- **`/consent`:** CSRF token required; Allow → recorded row, 302 with `code` + `state`; Deny → 302 with `error=access_denied`.
- **`/token` — code path:** happy path issues access + refresh; consumed code → `invalid_grant`; PKCE mismatch → `invalid_grant`; `redirect_uri` mismatch → `invalid_grant`; expired code → `invalid_grant`.
- **`/token` — refresh path:** happy path rotates; presenting a rotated token → `invalid_grant` **and** every row in the family is revoked in the same transaction (DB-state assertion).
- **`/revoke`:** unknown token → 200; known token → row marked revoked, family invalidated.

### Bearer middleware tests

- OAuth bearer → user resolved.
- Expired OAuth bearer → 401 with `WWW-Authenticate` header including `resource_metadata` URL.
- OAuth bearer path takes precedence over PAT bearer only when the token exists in `oauth_access_tokens`; otherwise falls through to the existing PAT path (regression that device-flow tokens still work).

### MCP tool tests (`mcp/tools.test.ts`)

- Each of the seven tools: happy path + `not_authenticated` + `forbidden` (another user's doc) + `not_found`.
- `primer_resolve_url` and `primer_get_document` URL-mode: valid slug URL, valid id URL, malformed URL, unknown slug.
- Round-trip: `create_document` → `resolve_url` on the returned URL → `get_document` by URL returns the same doc.

### Transport smoke (`mcp/transport.test.ts`)

- POST `/mcp` with `tools/list` → returns the seven tools.
- Bearer-less request → 401 with `WWW-Authenticate` header set.

### Manual verification checklist

- [ ] Add Primer as a Claude Web connector using the production URL. Full auth flow succeeds.
- [ ] Ask Claude to read a Primer URL, comment on what's there, then write a new HTML doc — one turn.
- [ ] Disconnect the connector in Claude Web, reconnect — consent screen does **not** reappear (memory works).
- [ ] Delete the consent row via SQL, reconnect — consent screen **does** reappear.
- [ ] Replay a rotated refresh token (via curl) — receives `invalid_grant`; DB rows in that family are all `revoked_at IS NOT NULL`.
- [ ] Verify existing CLI stdio path still works (`primer-mcp login` + a tool call) — regression.

## Section 8 — Rollout notes

- **Database:** one migration adding five tables. No changes to existing tables.
- **Env vars added:** `OAUTH_ISSUER` (base URL used in `.well-known` metadata). Everything else derives from existing config.
- **Redirect-URI allowlist:** encoded as a constant in `auth/oauth/clients.ts`. The exact set is finalized during implementation by observing what Claude Web and Claude Desktop advertise at DCR time and pinning to those literal URIs (plus `http://127.0.0.1:<any-port>` for local dev). If either client's advertised URI doesn't match one already in the constant, the implementation adds it in the same PR — the goal is a small explicit list, not a permissive pattern.
- **Deploy:** ships with the existing API deploy. No new service, no new Railway target.
- **Cutover:** none — this is additive.
- **Follow-ups (out of scope):**
  - Consolidate CLI onto the remote transport, deprecate device flow.
  - "Connected apps" account page for user-driven revocation.
  - Scope splitting (`primer:read` vs `primer:write`) when a second consumer needs it.
