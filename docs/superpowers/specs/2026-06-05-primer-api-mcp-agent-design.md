# Primer — Programmatic API, MCP Interface & Agent Skill (design spec)

**Status:** draft, ready for review
**Date:** 2026-06-05
**Author:** Taylan Pince (with Claude)
**Predecessor specs:** [SP5 auth + ownership](./2026-05-18-primer-auth-ownership-design.md), [SP-markdown copy/upload](./2026-05-26-primer-markdown-copy-upload-design.md)

> Companion implementation plan: `docs/superpowers/plans/2026-06-05-primer-api-mcp-agent.md`

## Goal

Let a CLI-based coding agent (Claude Code or equivalent) publish to Primer directly. The end-to-end experience:

> A user instructs their agent to generate an HTML or Markdown artifact. The agent creates a new Primer document, hands back the shareable URL, and — as the user iterates — uploads new versions under the same document. The agent can also pull all comments on a version so it can act on reviewer feedback.

Three deliverables, one dependency chain:

1. **Programmatic API auth** — a personal-access-token (PAT) layer so non-browser clients can authenticate against the existing REST API. The PRD lists "service-to-service auth / machine clients" as out of scope for v1; this spec lifts that exclusion deliberately and narrowly.
2. **MCP interface** — a small `@primer/mcp` stdio server that exposes Primer's operations as MCP tools, authenticated with a PAT. Agents add it with `claude mcp add`.
3. **Agent skill** — a Claude Code skill (`primer`) that teaches the agent *when and how* to use the MCP tools: create → share → iterate (add version) → fetch feedback → repeat.

The mental model: **the API is the capability + auth surface, the MCP is the tool surface for agents, and the skill is the workflow layer that orchestrates the tools.** Each layer is independently useful and testable; each depends only on the one below it.

## Why this is small

The REST surface already supports every verb the workflow needs. No new document/version/comment endpoints are required:

| Workflow step | Existing endpoint |
|---|---|
| Create document + first version | `POST /api/upload` (multipart; HTML **and** Markdown already supported) |
| Add a new version | `POST /api/documents/:docId/versions` |
| List versions | `GET /api/documents/:docId/versions` |
| Resolve latest version id | `GET /api/documents/:docId` → `latestVersion.id` |
| **Fetch all comments on a version** | `GET /api/versions/:versionId/threads` → threads **with all comments inlined** |
| Confirm identity (whoami) | `GET /api/me` |

So the bulk of the work is **authentication for machine clients** plus the **two thin layers** (MCP, skill) on top. The API sub-project is the only one that touches the existing server.

## Non-goals

- **Granular token scopes / least privilege.** A PAT carries the full authority of the user who minted it (read any doc, comment, manage own docs). Per-token read-only or per-document scoping is a v2 escape hatch. (Section 7.)
- **Remote/HTTP MCP transport.** We ship a local **stdio** server. A hosted Streamable-HTTP MCP endpoint mounted on the Hono app is a viable later phase but is explicitly out of scope here (decision D2).
- **OAuth device flow for the CLI.** Tokens are minted in the web UI and pasted into the agent's environment. No interactive OAuth from the CLI.
- **Rate limiting / quotas on token use.** Okta and the existing infra posture cover the threat model for v1.
- **A standalone Primer CLI binary.** The MCP server is the integration point. (A curl-based fallback is documented in the skill but not a shipped artifact.)
- **Publishing comments via the agent.** v1 is read-only for comments from the agent's side (fetch feedback). Posting replies from the agent is a plausible follow-up but not in scope.
- **New document/version/comment read or write endpoints.** The existing surface is sufficient.

---

## Section 1 — Architecture overview

```
┌─────────────────────────┐     stdio (MCP)      ┌──────────────────────┐
│  Claude Code / CLI agent │  ◀───────────────▶   │  @primer/mcp server  │
│  + `primer` skill        │   tools: create,     │  (apps/mcp, Node)    │
└─────────────────────────┘   add_version,        └──────────┬───────────┘
                              get_comments, …                 │ HTTPS + Bearer PAT
                                                              │ Authorization: Bearer primer_pat_…
                                                              ▼
                                              ┌───────────────────────────────┐
                                              │  Primer API (apps/api, Hono)   │
                                              │  authMiddleware                │
                                              │   └─ composeResolvers(         │
                                              │        bearerResolver,  ◀── NEW│
                                              │        oktaResolver|mock)      │
                                              │  csrfMiddleware (bearer-exempt)│
                                              │  existing routes (unchanged)   │
                                              │  + /api/tokens routes   ◀── NEW│
                                              └───────────────────────────────┘
```

### Auth pipeline change

Today `authMiddleware(resolver)` runs a single injected `UserResolver` (cookie→DB for Okta, or the mock). We introduce a **bearer resolver** and **compose** it ahead of the existing one:

```
authMiddleware(composeResolvers(bearerResolver, fallbackResolver))
  bearerResolver:   Authorization: Bearer primer_pat_… → hash → api_tokens ⋈ users
  fallbackResolver: the existing okta-cookie resolver (prod) or mock resolver (dev/test)
```

The composite tries bearer first; if there is no usable `Authorization` header it falls through to the cookie/mock path. Whichever resolver wins records **how** the request authenticated via `c.set('authMethod', 'bearer' | 'cookie' | 'mock')`.

### CSRF change

The custom-header CSRF guard (`X-Primer-Csrf: 1`) exists because cookies are ambient credentials. **A bearer token is not ambient** — a browser never attaches an `Authorization` header to a cross-site request on its own — so CSRF cannot target a bearer-authed request. The middleware therefore **skips the CSRF check when `authMethod === 'bearer'`**. This is keyed off the resolver result (not raw header presence) so a stray `Authorization` header on a cookie-authed request can't bypass the guard.

> Note carried from `csrf.ts`: this remains safe only while Primer has **no permissive CORS**. The bearer exemption does not change that invariant — it relies on the same "browsers don't send custom/Authorization headers cross-site without CORS" property.

### What is unchanged

Every existing route handler reads `c.get('user')` exactly as before. The bearer path produces the same `{ id, email, displayName }` shape. Ownership checks (`uploaderId === user.id`), soft-delete enforcement, mention validation, ETag/304 polling — all untouched. A PAT-authed agent is, to the rest of the app, just its owner.

---

## Section 2 — Data model

One new table.

```ts
// packages/shared/src/schema.ts (append)

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),                  // human label, e.g. "claude-code laptop"
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
```

**Token format.** `primer_pat_` + base64url(32 random bytes). The `primer_pat_` prefix makes leaked tokens greppable and lets secret-scanning recognize them. Example: `primer_pat_8Jq3…` (≈43 random chars).

**Hashing.** We store **only** `sha256(token)` as hex. Lookup hashes the presented token and selects by `token_hash` (the unique index is the lookup key). A fast hash is appropriate here — the secret is 256 bits of CSPRNG entropy, so there is nothing to brute-force; this matches how GitHub-style PATs work. No bcrypt/argon.

**`token_prefix`** stores the first 8 chars of the random part so the web UI can show "`primer_pat_8Jq3…`" in the token list without ever holding the secret again.

**Validation query** (once per bearer request):

```sql
SELECT u.id, u.email, u.display_name, t.id AS token_id
FROM api_tokens t
JOIN users u ON u.id = t.user_id
WHERE t.token_hash = $1
  AND t.revoked_at IS NULL
  AND (t.expires_at IS NULL OR t.expires_at > now())
LIMIT 1
```

**`last_used_at`** is updated fire-and-forget, **throttled** (only written when the stored value is null or older than ~60s), mirroring `refreshSessionIfStale`. A failed update never fails the request.

**Cleanup.** `purgeExpiredTokens` is added to the existing `startPurgeInterval` tick: `DELETE FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days'` (keep revoked rows briefly for audit, then drop). Expired-but-not-revoked rows are harmless (the query already rejects them) and are left for the user to delete; we do not auto-delete them.

**No data migration.** New table; nothing to backfill.

---

## Section 3 — API surface

### New token-management endpoints (`apps/api/src/routes/tokens.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/tokens` | any authenticated identity | Mint a token. Body `{ name: string, expiresInDays?: number }`. Returns `{ id, name, token, tokenPrefix, createdAt, expiresAt }` — **`token` (the plaintext secret) is returned exactly once and never again.** |
| `GET` | `/api/tokens` | any authenticated identity | List the caller's tokens (metadata only): `{ id, name, tokenPrefix, createdAt, lastUsedAt, expiresAt, revokedAt }[]`. Never includes the secret. |
| `DELETE` | `/api/tokens/:id` | owner only | Revoke (set `revoked_at`). 404 if not found or not owned. Idempotent. |

These are normal cookie-CSRF-protected mutating routes for the web UI. They are also reachable by a bearer identity (a token can mint another token); we accept that for v1 simplicity and note it in Section 6.

### DTOs (`packages/shared/src/api.ts`, append)

```ts
export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
export interface CreateTokenRequest { name: string; expiresInDays?: number; }
export interface CreateTokenResponse extends ApiTokenSummary { token: string; } // secret, once
export interface ApiTokensListResponse { tokens: ApiTokenSummary[]; }
```

### Resolver & middleware (`apps/api/src/auth/resolver.ts`, `app.ts`, `middleware/auth.ts`, `auth/csrf.ts`)

- `makeBearerResolver()` — reads `Authorization`, requires the `Bearer primer_pat_` shape, hashes, runs the validation query, throttled-touches `last_used_at`, sets `c.set('authMethod','bearer')`, returns the user (or `null` to fall through).
- `composeResolvers(...resolvers)` — returns the first non-null result.
- `AppVariables` gains `authMethod?: 'bearer' | 'cookie' | 'mock'`. The okta/mock resolvers set their respective values.
- `csrfMiddleware` early-returns when `c.get('authMethod') === 'bearer'`.

### Upload over the API

The existing `POST /api/upload` and `POST /api/documents/:docId/versions` accept **multipart form-data** with a `file` part (a `File`/`Blob` with a `.html`/`.md`/`.markdown` filename) plus `title`/`description`/`versionNote` text parts. The MCP server constructs this with `FormData` + `Blob` — **no server change is needed**. Raw-JSON-body upload was considered and rejected (D4): it would duplicate the validation/markdown branch and diverge from the web path.

---

## Section 4 — MCP server (`apps/mcp`, package `@primer/mcp`)

A standalone runnable workspace package (consistent with `apps/api`/`apps/web` being the runnable apps; `packages/*` stays for libraries). Built and published as a stdio MCP server.

### Configuration (env)

| Var | Required | Meaning |
|---|---|---|
| `PRIMER_API_URL` | yes | Base URL, e.g. `https://primer.up.railway.app` or `http://localhost:3000` |
| `PRIMER_API_TOKEN` | yes | A `primer_pat_…` secret |

On startup, missing/blank env → exit with a clear stderr message (MCP servers report fatal config errors before the transport handshake).

### Transport

`StdioServerTransport` from `@modelcontextprotocol/sdk`. Agents register it:

```bash
claude mcp add primer \
  --env PRIMER_API_URL=https://primer.up.railway.app \
  --env PRIMER_API_TOKEN=primer_pat_… \
  -- npx -y @primer/mcp
```

or via project `.mcp.json` (documented in the package README and the skill).

### Tools

All tools return both **structured JSON** (`structuredContent`) and a **human-readable text** summary. Errors from the API (401/403/404/400) map to descriptive MCP tool errors (e.g. 401 → "Primer token is invalid, expired, or revoked — mint a new one in Settings → API tokens").

| Tool | Input | Maps to | Returns |
|---|---|---|---|
| `primer_whoami` | – | `GET /api/me` | `{ id, email, displayName }` — confirms the token works |
| `primer_create_document` | `{ title, description?, content, format: "html"\|"markdown" }` | `POST /api/upload` | `{ documentId, versionId, url }` |
| `primer_add_version` | `{ documentId, content, format, versionNote? }` | `POST /api/documents/:id/versions` | `{ versionId, versionNumber, url }` |
| `primer_get_document` | `{ documentId }` | `GET /api/documents/:id` | document + `latestVersion` (incl. `latestVersion.id`) |
| `primer_list_versions` | `{ documentId }` | `GET /api/documents/:id/versions` | version list |
| `primer_get_comments` | `{ versionId }` **or** `{ documentId }` (resolves to latest version) | `GET /api/versions/:versionId/threads` | threads + comments, formatted for review |

`content` is passed **inline** as a string (artifacts are ≤10 MB; the agent already holds the bytes). A file-path input mode was considered and deferred (D5).

`primer_get_comments` formatting (the feedback feature) groups by thread and renders, per thread: the anchored selection text, resolved/open state, and each comment's author + body + timestamps — so the agent can read the feedback and act on it. The `url` field of each returned object always uses `PRIMER_API_URL` so links are clickable.

### Internal modules

- `src/client.ts` — `PrimerClient` (one method per endpoint; builds multipart for uploads; injects the Bearer header; normalizes errors).
- `src/format.ts` — pure `formatComments(threads)` → markdown summary (unit-tested).
- `src/tools.ts` — zod input schemas + handlers, registered on an `McpServer`.
- `src/index.ts` — env load, client + server construction, stdio connect.

### Testing

Pure-logic + mocked-`fetch` unit tests (Vitest, node env — same posture as the rest of the repo): client request shaping (headers, multipart, error mapping), comment formatting, and tool handlers against a mocked client. An optional integration smoke (boot the API in-memory via `createApp` with a bearer-enabled resolver, point a real `PrimerClient` at `app.request`) is described in the plan as a stretch task.

### Supply chain

`@modelcontextprotocol/sdk` and `zod` must clear the workspace's `minimumReleaseAge: 14 days` gate and `blockExoticSubdeps` — both are mainstream npm packages with no exotic subdeps and no postinstall scripts. Pin versions ≥14 days old. `pnpm-lock.yaml` is regenerated and committed.

---

## Section 5 — Agent skill (`primer`)

A Claude Code skill checked into the repo at `.claude/skills/primer/SKILL.md` (dogfoodable here; copyable/distributable to other agents). The skill is the **workflow brain** over the MCP tools.

### Frontmatter

```yaml
---
name: primer
description: >-
  Publish and iterate on LLM-generated HTML or Markdown artifacts in Primer.
  Use when the user wants to share an artifact at a stable URL, push a new
  version as they iterate, or pull reviewer comments/feedback on a version.
  Requires the @primer/mcp server configured with a PRIMER_API_TOKEN.
---
```

### Body (workflow)

1. **Preflight** — confirm the `primer_*` MCP tools are available; if not, point the user at the README (`claude mcp add primer …`) and the token page (`Settings → API tokens`). Optionally call `primer_whoami` to verify the token.
2. **Create vs. iterate** — if this is a new artifact, call `primer_create_document` (choose `format` from the content/extension) and **remember the `documentId`** by writing `.primer/document.json` (`{ documentId, url, title }`) in the working dir so later turns target the same doc. If a `.primer/document.json` exists (or the user names an existing doc), use `primer_add_version` instead.
3. **Share** — surface the returned `url` to the user immediately.
4. **Iterate** — on each requested change, regenerate the artifact and `primer_add_version` with a concise `versionNote` describing what changed ("fixed Y-axis scale", "added Q2 numbers").
5. **Gather feedback** — when the user asks for feedback/comments, call `primer_get_comments` (latest version by default). Summarize open threads, propose fixes, and after applying them push a new version whose `versionNote` references the addressed feedback.

### Conventions captured in the skill

- Persisting `documentId` across turns (`.primer/document.json`).
- Format selection (`.md`/`.markdown` → markdown, else html) and the 10 MB limit.
- The two upload-time mutations Primer makes (strips nested `<iframe>` and `<meta http-equiv=refresh>`) so the agent doesn't rely on them.
- Never echo the `PRIMER_API_TOKEN`.

A `reference.md` alongside `SKILL.md` holds the full tool I/O reference so the main skill body stays short (progressive disclosure).

---

## Section 6 — Security

- **Tokens hashed at rest** (sha-256 hex); plaintext shown exactly once on creation. The `token_hash` unique index is the lookup key, so validation is an indexed point-lookup (no timing side channel on a per-character compare).
- **Revoke + expiry** are first-class; the validation query rejects both. Revoked rows linger 30 days for audit, then purge.
- **CSRF**: bearer requests are exempt because they carry no ambient credential; the exemption is keyed off the winning resolver, not raw header presence. The "no permissive CORS" invariant from `csrf.ts` still holds and is reaffirmed.
- **Authority**: a PAT == its owner. No scopes in v1 (Section 7). A token can mint/revoke tokens for its own user; acceptable given equal authority, flagged for the v2 scope model.
- **Transport**: the MCP server only ever talks to `PRIMER_API_URL` over whatever scheme is configured; prod is HTTPS. The token lives in the agent's process env, never in the repo.
- **Secret scanning**: the `primer_pat_` prefix is greppable; `mcp__github__run_secret_scanning` / GitHub push protection can be pointed at the pattern. Document the prefix.
- **Logging**: the API request logger already logs `user_id` only; ensure token routes never log the secret or the hash. The MCP server must not log the token.
- **Mock mode**: in `AUTH_MODE=mock`, bearer resolution still works (tokens resolve to their owner) but falls back to `mock-user-1` when absent, so local end-to-end testing of the MCP is possible without Okta. Mock mode remains forbidden in production (existing `index.ts` guard).

---

## Section 7 — Out of scope / deferred

- **Token scopes** (read-only, per-document, per-action). v2.
- **Remote HTTP MCP transport** mounted on the API. Future phase (D2).
- **Agent-authored comments / replies.** Fetch-only in v1.
- **CLI OAuth/device flow.** Tokens are pasted from the web UI.
- **Rate limiting / usage analytics per token.** The admin stats endpoint could gain a token bucket later.
- **A published, versioned npm release of `@primer/mcp` to a public registry.** v1 targets `npx` from the repo / an internal registry; public publishing is an ops follow-up.
- **A standalone `primer` CLI.** The MCP server is the interface; a curl fallback is documented only.
- **Raw-JSON upload body.** Multipart reuse only (D4).

---

## Decision log

| # | Topic | Decision |
|---|---|---|
| D1 | Machine auth mechanism | Personal access tokens (`primer_pat_…`), sha-256 hashed, bearer header. No OAuth client-credentials in v1. |
| D2 | MCP transport | **Local stdio package** (`@primer/mcp`). Remote HTTP on the API deferred. |
| D3 | Resolver integration | Compose `bearerResolver` ahead of the existing okta/mock resolver; record `authMethod`; CSRF exempts bearer. No change to route handlers. |
| D4 | Upload over API | Reuse the existing multipart endpoints; MCP builds `FormData`. No raw-JSON upload path. |
| D5 | MCP content input | Inline `content` string. File-path input deferred. |
| D6 | Token scopes | Full-user authority in v1; granular scopes deferred to v2. |
| D7 | Skill location | In-repo `.claude/skills/primer/` (dogfood + distributable). Orchestrates MCP tools; no bundled binary. |
| D8 | Comment fetch | Reuse `GET /api/versions/:versionId/threads`; the MCP formats threads+comments for review. Fetch-only. |
| D9 | Package placement | `apps/mcp` (runnable), not `packages/` (libraries). |
| D10 | Token mgmt reachability | Any authenticated identity may manage tokens in v1 (cookie or bearer); revisit with scopes. |
