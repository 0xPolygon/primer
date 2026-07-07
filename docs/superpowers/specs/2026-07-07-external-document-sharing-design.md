# External Document Sharing — Design

**Date:** 2026-07-07
**Status:** Approved design, pending implementation plan

## Summary

Allow internal users (sales and other teams) to selectively share individual
documents with external clients, gated by an email allowlist plus a 6-digit
OTP email confirmation. External viewers get a distraction-free, full-screen,
read-only view of an explicitly published version. The documents involved
carry real confidentiality (deal terms, pricing, pre-release material), so the
email gate is a genuine security control, not just an audit convenience.

## Goals

- Share a document with specific external email addresses; nobody else can
  view it, even with the link.
- Prove inbox ownership with a 6-digit OTP before granting access.
- External viewers see exactly one explicitly published version, full screen,
  with no comment bezel, toolbar, or other internal UI.
- Polygon branding on all external-facing screens (email entry, OTP entry,
  error states) and emails.
- Per-recipient expiry and revocation; doc-level kill switch.
- Audit log of external views; notify the sharer on a recipient's first view.

## Non-goals (v1)

- External commenting or feedback.
- Download/export buttons for external viewers.
- Watermark overlay (considered, deferred).
- Per-share strictness settings (session TTL, OTP-per-visit modes).
- Admin/allowlist controls over which internal users may share externally —
  any doc owner/editor can.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Sensitivity model | Real confidentiality | Leaked link must not grant access; gate hardened accordingly |
| Recipient capability | View published version only | Smallest external surface |
| Viewer session | ~30-day device cookie | DocSend/Notion norm; DB-backed so revocation is still immediate |
| Version exposure | Explicit "publish to external" step | Prevents draft/speaker-note leakage from live-latest semantics |
| Sharer permission | Doc owner + editors (existing `canEdit`) | Reuses permission model, no new admin machinery |
| OTP vs magic link | 6-digit typed OTP | Corporate mail scanners (Safe Links, Mimecast) pre-fetch and burn one-time links; typed codes are immune |
| Architecture | Integrated into existing API/web apps | Separate cookie + session table gives sufficient isolation without a second service |
| v1 extras | Expiry, view audit log, first-view notification | Watermark deferred |

## Architecture

New "external viewer" identity plane, fully separate from the internal one:

- External viewers never get rows in `users`, never touch Okta, `primer_sid`
  sessions, PATs, OAuth tokens, or the MCP surface.
- A small set of unauthenticated routes under `/share/:shareToken` (frontend)
  and `/api/share/:shareToken/*` (API), added to the auth middleware's public
  paths.
- Content is served through a share-scoped endpoint that can only ever return
  the published version of that share's document — a parallel narrow path,
  not a branch inside the internal permission check.

## Data model

Four new tables (Drizzle, `packages/shared/src/schema.ts`):

### `external_shares`

One active share per document (unique on `documentId` where not revoked).

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `documentId` | FK → documents |
| `shareToken` | ≥128-bit random, base64url, unique; the URL token. Deliberately not the doc UUID so URLs are non-enumerable and revocable independent of the doc |
| `publishedVersionId` | FK → versions, **nullable** — nothing is externally visible until the first explicit publish |
| `createdBy` | FK → users |
| `createdAt` | timestamp |
| `revokedAt` | nullable — doc-level kill switch |

### `external_recipients`

The email allowlist for a share.

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `shareId` | FK → external_shares |
| `email` | normalized lowercase; unique per (shareId, email) |
| `addedBy` | FK → users |
| `createdAt` | timestamp |
| `expiresAt` | default now + 90 days, adjustable per recipient |
| `revokedAt` | nullable — per-recipient revocation |
| `firstViewedAt` | nullable — set on first content view; triggers sharer notification |

### `external_otps`

Pending verification codes. Attempt counting lives in Postgres, not the
in-memory rate limiter, so limits survive deploys and instance restarts.

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `recipientId` | FK → external_recipients |
| `codeHash` | SHA-256 of the 6-digit code; constant-time comparison |
| `attemptCount` | max 5 wrong attempts, then the code is dead |
| `createdAt` | timestamp |
| `expiresAt` | 10 minutes |
| `consumedAt` | nullable — single use |

Code generation uses `randomBytes` + rejection sampling (same unbiased
approach as `apps/api/src/auth/tokens.ts`).

### `external_viewer_sessions`

Mirrors the internal `sessions` table but entirely separate.

| Column | Notes |
|---|---|
| `id` | random hex (same generation pattern as internal sessions) |
| `recipientId` | FK → external_recipients |
| `createdAt` | timestamp |
| `expiresAt` | 30 days, no sliding refresh |
| `lastSeenAt` | timestamp |
| `userAgent` | text |

Cookie: `primer_ext_sid` — HttpOnly, Secure (on HTTPS), SameSite=Lax. A
distinct name from `primer_sid`; meaningless on internal routes.

### `external_views` (audit)

| Column | Notes |
|---|---|
| `id` | UUID PK |
| `recipientId` | FK → external_recipients |
| `versionId` | FK → versions — records exactly which version was seen |
| `viewedAt` | timestamp |
| `ip`, `userAgent` | text |

## Lifecycle rules

Enforced at request time on **every** external request (session validation
joins session → recipient → share → document):

- Share revoked → all access dead, including existing viewer sessions.
- Recipient revoked or `expiresAt` passed → dead, including existing sessions.
- Document soft-deleted → external routes return 404.
- `publishedVersionId` null → viewer shows a branded "nothing is published"
  state (post-verification only).

Revocation is immediate because everything is DB-backed; nothing is encoded
in signed tokens that could outlive a revocation.

## External viewer flow

1. **Landing** — `GET /share/:shareToken` serves a Polygon-branded email-entry
   screen. The document title is **not** shown pre-verification; a forwarded
   or leaked URL reveals only "a document has been shared with you." An
   invalid/revoked token renders the same screen (no token-validity oracle).
2. **Request code** — `POST /api/share/:shareToken/request-code { email }`.
   Response is always the same ("If this address has access, we've emailed a
   code") whether or not the email is on the allowlist — no enumeration, and
   response timing should not differ observably (send email async). If the
   recipient is valid and active: invalidate any prior unconsumed OTP for
   that recipient, generate a code, store its hash, send a branded Mailgun
   email containing the code (no login link needed — the user is already on
   the page).
3. **Verify** — `POST /api/share/:shareToken/verify { email, code }`.
   Checks: OTP exists, unconsumed, unexpired, `attemptCount < 5`,
   constant-time hash comparison. Failure increments `attemptCount` and
   returns a generic error. Success: mark consumed, create viewer session,
   set `primer_ext_sid`, client proceeds to the viewer.
4. **View** — after verification the client navigates to
   `GET /api/share/:shareToken/content`, which serves the published version's
   HTML as a **top-level document** — identical delivery to the internal
   full-screen mode (`document.tsx` opens `/api/versions/:id/content`
   directly). A sandboxed iframe cannot be used here: sandboxed-iframe
   subresource requests are cross-site and strip the SameSite=Lax viewer
   cookie (see `apps/api/src/middleware/auth.ts`). The same strict
   `ARTIFACT_CSP` applies (`connect-src 'none'`, `form-action 'none'`), the
   cookie is HttpOnly, and unauthenticated/unpublished requests 302 back to
   the branded landing page. Each successful load writes an `external_views`
   row.

All `/share` responses carry `X-Robots-Tag: noindex`.

## Abuse protections

- **OTP brute force:** 5-attempt cap in the DB, 10-minute TTL, single-use,
  constant-time compare. 6 digits × these limits ⇒ worst-case guessing odds
  5 in 1,000,000 per code issuance.
- **Send abuse (email bombing / Mailgun cost):** rate-limit `request-code`
  per email address, per IP, and per share using the existing in-memory
  limiter (`apps/api/src/lib/rateLimiter.ts`) as the first line; the DB
  attempt/issuance records are the durable backstop.
- **Enumeration:** identical responses for allowlisted vs. unknown emails and
  for valid vs. invalid share tokens.
- **Session theft:** cookie is HttpOnly + Secure; sessions are revocable
  server-side; the sandboxed artifact iframe runs in an opaque origin and
  cannot read cookies.

## Internal sharer UX

On the document detail page, visible to owner + editors only (existing
`canEdit` from `apps/api/src/lib/permissions.ts`), in the ShareModal area:

- **Create external share** — generates the share + URL; the document gains a
  visible "Shared externally" badge wherever internal users see it.
- **Recipients** — add emails (with optional expiry override), see status
  (pending / viewed / expired / revoked), revoke individually.
- **Publish to external** — point `publishedVersionId` at a chosen version.
  The panel clearly shows which version externals currently see vs. the
  latest internal version, so drift is obvious. New internal uploads change
  nothing externally until re-published.
- **Revoke share** — doc-level kill switch; ends all recipient access and
  sessions immediately.
- **View log** — per-recipient view history from `external_views` (doubles as
  engagement signal for sales).

Internal API routes for all of the above live behind the existing auth
middleware and `canEdit` checks.

## Notifications (Mailgun, existing `Notifier` pattern)

- **OTP email** — Polygon-branded, contains the 6-digit code and basic
  context ("You've been given access to a document on Primer"), not the
  document title (the recipient hasn't verified yet) and no clickable
  auth link.
- **First-view notification** — when `firstViewedAt` transitions from null,
  email the recipient's `addedBy` sharer: "{email} viewed {doc title}."
- With incomplete Mailgun env config the existing `NoopNotifier` fallback
  applies; the OTP flow must hard-fail gracefully in that case (external
  sharing is unusable without email — surface this in the sharer UI rather
  than silently sending nothing).

## Isolation from internal surfaces

- MCP tools, library listings, and dashboards are unchanged; external
  viewers are not `users` and never appear as such.
- External share metadata (recipients, view log) is visible only to internal
  users who can already edit the doc.
- The share-scoped content endpoint cannot serve unpublished versions, other
  documents' versions, or deleted documents — its query is keyed by the
  share row, not by caller-supplied version IDs.

## Error handling

- Invalid/revoked/expired anything on external routes → generic branded
  screens; no distinction leaked between "bad token," "not on list,"
  "expired," beyond what the user inherently knows.
- Expired viewer session → drop back to the email-entry screen (re-OTP).
- `NoopNotifier` active → sharer-side UI warns that external sharing is
  non-functional; `request-code` returns 503 rather than pretending to send.

## Testing

- **Unit:** OTP lifecycle (expiry, attempt cap, single-use, constant-time
  compare, reissue invalidates prior), recipient expiry/revocation cascades,
  share revocation cascade, session validation join chain, content endpoint
  scoping (cannot reach unpublished versions or other docs).
- **Enumeration:** response-equality tests for known vs. unknown emails and
  valid vs. invalid tokens.
- **Integration:** full flow — create share → add recipient → publish →
  request code (mock notifier captures code) → verify → fetch content →
  audit row written → first-view notification sent → revoke → access dead.
- **Manual verification in the real flow:** with `AUTH_MODE=mock`, the
  external plane is exercisable end-to-end locally (mock auth affects only
  the internal plane); the mock notifier can log codes to console for local
  walkthroughs.

## Out-of-scope follow-ups (noted, not designed)

- Watermark overlay with the viewer's email (redistribution deterrent).
- External feedback/commenting.
- Per-share session strictness settings.
- Designated-sharer allowlists / admin controls.
- Redis-backed rate limiting if the deployment ever scales past one instance.
