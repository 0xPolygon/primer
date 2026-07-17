# Per-user API tokens for the MCP server (+ Claude service account)

## Context

External tools — notably Claude Tag (Claude in Slack) — need to authenticate against Primer's MCP server (`POST /mcp`). Investigation showed the hard parts **already exist**: an `api_tokens` table, `primer_pat_*` generation/SHA-256 hashing (`apps/api/src/auth/tokens.ts`), a bearer resolver that authenticates `Authorization: Bearer primer_pat_…` on `/mcp` and all `/api/*` routes (`apps/api/src/auth/bearer.ts`, composed in `apps/api/src/index.ts:99`), list/revoke endpoints (`apps/api/src/routes/tokens.ts`), and a `/settings/tokens` page. Today, tokens can only be **minted** via the device-login flow.

Decisions made with the user:
1. **Personal tokens** created self-serve from the web UI; each acts as the creating user; **never expire** (revoke-only lifecycle).
2. **A "Claude" service account** — a seeded service user so external tools can act as Claude itself — with tokens minted/revoked from an **admin-gated UI section**, admin = email in a new `ADMIN_EMAILS` env allowlist.

No schema changes needed: `users.email` is notNull but not unique; `api_tokens.expiresAt` is already nullable. MCP tool handlers already receive the bearer-resolved user (`apps/api/src/mcp/transport.ts:46`), so service-user attribution flows through with zero MCP changes.

## Implementation steps

### 1. Shared DTOs — `packages/shared/src/api.ts`
- `MeResponse extends UserDTO { isAdmin: boolean }`
- `CreateTokenRequest { name: string }`
- `CreateTokenResponse { token: string; summary: ApiTokenSummary }`
- Reuse `ApiTokensListResponse`/`CreateTokenResponse` for service-token endpoints. Do **not** add `isAdmin` to `UserDTO` (reused by mention/search lists).

### 2. Admin helper — `apps/api/src/auth/admin.ts` (new)
- `SERVICE_USER_ID = 'service-claude'`
- `parseAdminEmails(raw)` — split on `,`, trim, lowercase, drop empties.
- `isAdmin(user, adminEmails)` — case-insensitive email match.

### 3. Plumb through app — `apps/api/src/app.ts`
- `AppDeps` gains `adminEmails?: string[]`; in `createApp`: `deps.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS)`.
- Pass to `registerMeRoute` and new `registerServiceTokenRoutes`. Startup log of admin count (not emails) in `index.ts`.

### 4. Seed migration (data-only)
- `cd apps/api && pnpm exec drizzle-kit generate --custom --name=seed_service_user` → `apps/api/drizzle/0011_seed_service_user.sql`, mirroring `0001_seed_mock_user.sql`:
  `INSERT INTO users (id, email, display_name) VALUES ('service-claude', 'claude-service@polygon.technology', 'Claude') ON CONFLICT (id) DO NOTHING;`
- The text id can never collide with an Okta sub, so this account can't log in interactively.

### 5. `POST /api/tokens` (personal create) — `apps/api/src/routes/tokens.ts`
- Extract `TokenRow`/`toSummary` into `apps/api/src/routes/tokenSummary.ts` for reuse.
- Validate `name`: string, trimmed, 1–100 chars → else `400 {error:'invalid_name'}`.
- Cap: 25 active (non-revoked) tokens per user → `400 {error:'token_limit'}`.
- Mint via `generateToken()` + `uuidv7()`, insert with `expiresAt: null`; return `201 CreateTokenResponse` — plaintext appears in this response only; copy the `// CRITICAL: do NOT log the token plaintext` comment from `device.ts:255`. No transaction needed (single insert).

### 6. Service token routes — `apps/api/src/routes/serviceTokens.ts` (new)
- All handlers gate first: non-admin → `403 {error:'forbidden'}`.
- `GET /api/service-tokens` — list where `user_id = SERVICE_USER_ID`.
- `POST /api/service-tokens` — same validation/cap/mint as step 5 with `userId: SERVICE_USER_ID`.
- `DELETE /api/service-tokens/:id` — scoped existence check → 404; idempotent revoke; mirror `tokens.ts:60-83`.

### 7. `/api/me` + user-picker filtering
- `apps/api/src/routes/me.ts`: return `MeResponse` with `isAdmin`.
- `apps/api/src/routes/users.ts`: exclude `SERVICE_USER_ID` from mentionable + search results (note: means Claude can't be @mentioned/added as collaborator — acceptable for now, revisit if needed).

### 8. Web UI
- `apps/web/src/queries/me.ts`: type → `MeResponse`.
- `apps/web/src/queries/tokens.ts`: add `useCreateToken`, `useServiceTokens(enabled)` (pass `me.isAdmin` so non-admins never fire the 403), `useCreateServiceToken`, `useRevokeServiceToken`; invalidate `['tokens']` / `['service-tokens']`.
- `apps/web/src/routes/settings-tokens.tsx`:
  - Update header/empty-state copy (currently says "run the device-login flow").
  - `CreateTokenForm` component (shared by both sections): name input + inline validation + error display.
  - One-time secret reveal on success: monospace box, copy button, "will not be shown again" warning; kept in component state only, never in the query cache.
  - Admin-only "Service account (Claude)" section below the personal list, reusing `TokenRow` with service hooks.

### 9. Env docs — `.env.example`
- Document `ADMIN_EMAILS` (comma-separated, case-insensitive; unset = fail-closed, no admins; mock user email for local dev is `mock@polygon.technology`).

### 10. Tests (vitest, real test DB — seed applies via `pnpm db:migrate:test`)
- **`apps/api/src/routes/tokens.test.ts`** — ⚠️ must **replace** the existing block at lines 274–286 asserting `POST /api/tokens` → 404 ("manual mint not in v1"). New suite: 201 shape (`primer_pat_` prefix, `expiresAt: null`, no secret material in summary), minted token authenticates as creator, name validation (missing/empty/whitespace/101 chars/trim), 25-token cap (revoked don't count).
- **`apps/api/src/routes/serviceTokens.test.ts`** (new): non-admin 403 on all three routes; admin list scoped to service tokens (and personal list excludes them); attribution — minted service token → `/api/me` returns `id === 'service-claude'`; revoke → bearer 401; unknown id 404; case-insensitive allowlist.
- **`me.test.ts`**: `isAdmin` false default / true when allowlisted / case-insensitive.
- **`users.test.ts`**: `service-claude` excluded from mentionable + search.

### Optional follow-up (flag, don't block)
- Gate `GET /api/admin/stats` (currently open to any SSO user) behind the new `isAdmin` helper; service user adds +1 to its user totals.

## Verification

```bash
pnpm db:up && pnpm db:migrate && pnpm db:migrate:test
pnpm typecheck && pnpm test
```

Manual (`.env`: `AUTH_MODE=mock`, `AUTH_BASE_URL=http://localhost:3000` so `/mcp` registers, `ADMIN_EMAILS=mock@polygon.technology`; `pnpm dev`):
1. `POST /api/service-tokens` → capture `token`.
2. `GET /api/me` with `Authorization: Bearer $TOKEN` → must return `service-claude` (bearer resolver runs before the mock fallback, which would return `mock-user-1`).
3. `POST /mcp` initialize without token → 401 + `WWW-Authenticate`; with token → 200 serverInfo.
4. Full tool call via a real MCP client (`claude mcp add --transport http primer http://localhost:3000/mcp --header "Authorization: Bearer $TOKEN"`) → `primer_whoami` identifies Claude. (Transport is stateless per POST; bare curl `tools/call` without initialize may be rejected by the SDK — use a client.)
5. UI: create/copy/revoke a personal token at `/settings/tokens`; confirm the admin section only renders for allowlisted emails.

## Notes / risks
- Tokens never expire by design — cap + `lastUsedAt` display are the hygiene; UI should say "Never expires" plainly.
- `useMe()` has `staleTime: Infinity` — `ADMIN_EMAILS` changes need a reload to show/hide the section; the server gate is authoritative.
- Branch per repo convention; this work isn't from a GitHub issue, so consider filing one and using `issue-<n>-api-tokens` if the board should track it.
