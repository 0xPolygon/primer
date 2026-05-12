# Primer — Decomposition Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-05-12
**Status:** Approved
**Companion PRD:** `docs/prd-primer.md`

## Purpose

Primer is too large to design or implement as a single spec. This document decomposes the work into seven independently-specifiable, independently-shippable sub-projects across two phases, captures the build order, and locks the cross-cutting constraints that apply to every sub-project.

Each sub-project will get its own brainstorming → spec → implementation-plan cycle in a later session. This document is the index that lets us pick the next sub-project off the shelf without re-litigating the whole scope.

## Phasing rationale

**Phase 1 builds a complete local application** with no real auth and no Slack notifications, exercised against a single mock user identity. The mock identity uses the same `User` table the real Okta integration will populate, so the data model is forward-compatible and Phase 2 plugs in without schema churn.

**Phase 2 wires in the real-world integrations** — existing Polygon Okta work, Slack DM notifier, and the element-path anchoring polish — and ships internally.

This split exists because there is already Polygon work for Okta auth that will be plugged in once the local app is solid. Trying to wire Okta during early development would consume time without changing the feature set being designed and tested, and the local dev loop is meaningfully simpler without it.

## Cross-cutting constraints

These apply to every sub-project. Each sub-project's spec should restate the relevant subset rather than rely on this doc.

- **Package manager:** pnpm exclusively. Never npm. Never yarn.
- **Local dev runner:** Do not use `wrangler dev` — it is unreliable on the developer's NixOS environment. Pick a Node/Bun/Vite/Next.js-native dev server instead. If Cloudflare Workers ends up as a deployment target, deploy via `wrangler deploy` and keep local dev on a different runtime.
- **No Okta in Phase 1.** Use a hardcoded single mock user (e.g., `mock-user-1` with a fixed email and display name) for `uploader_id`, `author_id`, and any other identity reference. The mock can be swapped for the real Okta `sub` in Phase 2 without data migration.
- **No Slack in Phase 1.** Notification entry points exist (the API hooks that *would* enqueue Slack jobs) but resolve to a no-op or a local stub. Phase 2's notifier worker plugs in behind the same interface.
- **Data model is forward-compatible from day 1.** The schema sketched in the PRD ships in Phase 1's first migration; later sub-projects extend rather than restructure.

## Sub-projects

### Phase 1 — Local app

#### 1. Local foundation

**Scope:**
- Repo scaffold with pnpm, TypeScript, chosen framework (decision deferred to this sub-project's spec).
- Local dev loop that boots without external services beyond Docker-Compose Postgres + a local filesystem path for object storage.
- Database migrations: first cut of `User`, `Document`, `Version` tables from the PRD data model. `Thread`, `Comment`, and anchor JSON tables stubbed but unused until sub-project 3.
- Mock user middleware: every request is attributed to a single fixed user.
- Upload pipeline: validate (single `.html` file, ≤10 MB, parses with a tolerant HTML parser), strip nested `<iframe>` and `<meta http-equiv="refresh">`, inject the companion script tag before `</body>` (the script itself is an empty stub here — sub-project 2 fills it in), persist the resulting HTML to local object storage keyed by `version_id`, write the `Version` row.
- Viewer route: render the iframe with the locked sandbox attrs (`allow-scripts allow-forms`) and locked CSP directives from the PRD. No comment sidebar; just the artifact.
- Empty home page placeholder route.

**Depends on:** —

**Exit criteria:** A developer can run `pnpm dev`, upload an `.html` file via a basic form, and view the rendered artifact at a stable URL inside a sandboxed iframe with the correct CSP applied.

**Deferred from this sub-project:**
- The companion script body (sub-project 2).
- Any comment storage or UI (sub-project 3).
- Versioning UI / multi-version per document (sub-project 4).
- Real auth (sub-project 5).
- The "My documents" / "Recently viewed" lists (sub-project 3 will introduce the dashboard surface; this sub-project just lands an empty placeholder).

#### 2. Anchoring + companion script

**Scope:**
- Companion script (`/companion/v1.js`) implementing the PRD's five responsibilities: text-range capture, element-pick capture, marker rendering, position resolution, external-nav forwarding.
- postMessage protocol (parent ↔ iframe) with the message types listed in the PRD, including `open_external(url)`.
- Shared-token handshake at iframe init to reject cross-document interference.
- Parent-side glue: validate `open_external` URLs (`https:` only) and open via `window.open(url, "_blank", "noopener,noreferrer")`.
- A test harness page in the app that loads a fixture artifact, captures a selection, and renders a highlight purely via postMessage round-trips. No comment persistence yet.

**Depends on:** 1.

**Exit criteria:** From the test harness, a developer can select text in an artifact, see the captured anchor data echoed back, and see a visual highlight rendered in-iframe via postMessage. External `<a target="_blank">` clicks inside the iframe open a new browser tab.

**Deferred from this sub-project:**
- Element-path anchor *resolution fallback* on render (sub-project 7). The element-path *capture* path is present in element-pick mode here; the resolve-with-fallback path is added later.
- Storing anchors against threads (sub-project 3).

#### 3. Comments + threading + dashboard

**Scope:**
- Migrate `Thread`, `Comment`, and `Anchor` JSON tables fully.
- Comment creation API and UI: floating "Add comment" affordance on selection / element pick, sidebar entry, anchor binding.
- Sidebar layout: 360px right column, collapsible to a thin rail; resolved-threads filter toggle.
- Replies within a thread.
- Resolve / reopen state; reply to a resolved thread auto-reopens.
- Edit and delete by comment author. Unlimited edits with "edited" indicator. Soft-delete leaves a tombstone.
- 10s polling on the active document view, foreground-only, with `If-None-Match` / `304` conditional requests.
- Dashboard: "My documents" and "Recently viewed or commented" (last 30 days, uncapped). Tracks recently-viewed in a lightweight table or activity log.
- Notification entry points wired but resolve to a no-op stub (sub-project 6 replaces the stub).

**Depends on:** 1, 2.

**Exit criteria:** Two browser sessions for the same mock user can carry on a threaded conversation on an uploaded artifact: drop a comment, reply, resolve, reopen-via-reply, edit, delete-as-tombstone. The home page lists artifacts that mock-user has uploaded or recently viewed.

**Deferred from this sub-project:**
- Multi-version per document and version selector (sub-project 4).
- Multi-user testing (Phase 2 once real auth lands; in Phase 1 the single mock user does both sides).
- Slack DMs (sub-project 6).

#### 4. Versioning + soft-delete

**Scope:**
- "Add a version to an existing document" flow: typeahead over the uploader's own documents, drop new HTML, optional version note. Always an explicit user action.
- `version_number` monotonic increment per `document_id`.
- Version selector in the document view, default to latest.
- URL scheme: `/d/{docId}` resolves to the latest version; `/d/{docId}/v/{versionNumber}` pins a specific version.
- Threads remain anchored to the version they were created on. Viewing an older version puts the document in read-mostly mode: no new top-level threads, but existing threads remain replyable / resolvable / reopenable.
- Metadata editing: uploader can edit document title and description (document-level), and version note (version-level). No edit history.
- Soft-delete with a 30-day reversal window; collapsed "Recently deleted" section on the uploader's home page.
- Hard purge job (cron or scheduled task) that removes versions, threads, comments, and storage objects older than 30d since soft-delete.

**Depends on:** 1, 3.

**Exit criteria:** A document can have multiple versions, each with its own thread set; old versions are read-mostly; the uploader can rename a doc and edit version notes; soft-deleted docs can be restored within 30 days and disappear permanently after.

**Deferred from this sub-project:**
- Cross-version notifications via Slack (sub-project 6).

### Phase 2 — Connect to the real world

#### 5. Auth + ownership

**Scope:**
- Plug in the existing Polygon Okta integration. Wire OIDC sign-in, session cookies, CSRF protection on mutating endpoints.
- Replace the mock-user middleware with real session resolution: `User.id` becomes the Okta `sub`; `email`, `display_name` populate on first sign-in.
- Enforce uploader-only rules end-to-end at the API layer (add-version, delete, metadata edit). Phase 1 had these conceptually owner-only but with only one user it was untestable.
- Multi-user test pass: confirm Phase 1 flows still work with two distinct authenticated users.

**Depends on:** 1, 4. (Effectively: all of Phase 1.)

**Exit criteria:** Two real Polygon Okta accounts can sign in, upload docs, and exercise ownership boundaries (only the uploader can delete, etc.) with no remaining mock-user assumptions.

#### 6. Slack notifications

**Scope:**
- Slack notifier worker: consumes from a jobs table (Postgres LISTEN/NOTIFY or simple poll-based job runner). Sends Slack DMs via the Slack Web API.
- Mention parsing: extract `@user` tokens from comment body. Diff against the prior body in the edit case so only *newly added* mentions fire DMs.
- Skip self-mentions. Don't notify users whose mention was removed via edit.
- Thread-reply DMs: on new comment creation (not edits), notify prior unique participants who aren't the new commenter.
- Okta-to-Slack ID resolution: on first sign-in, match Okta email against the Slack Web API and persist `slack_user_id` on `User`.
- @mention typeahead in the comment editor, sourced from the Okta directory (or `User` table after sign-ins propagate it).
- Deep links in DMs back to the document at the right version and thread.
- No rate limiting in v1; revisit if a chatty thread produces real complaints.

**Depends on:** 5.

**Exit criteria:** Authoring a comment that @-mentions a Polygon teammate sends them a Slack DM with a working deep link. Replying to a thread DMs prior participants. Editing a comment to add a new mention DMs the new user; editing to remove a mention does not.

#### 7. Element-path fallback + polish

**Scope:**
- Wire up the element-path anchor resolution path described in the PRD as the fallback when text-range resolution fails. (Capture was already present from sub-project 2; what's added here is the *render-time fallback*.)
- "Drifted" anchor state: sidebar still shows the comment with a small "location unknown" indicator if both resolution strategies fail.
- CSP / sandbox tightening or loosening based on what real uploaded artifacts actually need (we'll have telemetry-like signals by this point — broken artifact reports, CDN miss reports, etc.).
- Product copy for the canvas / no-region-anchoring limitation.
- Internal alpha launch to a small group of Polygon employees. Bug bash and triage.

**Depends on:** 2, 5, 6. (Effectively: all of Phases 1 and 2.)

**Exit criteria:** Primer ships to an internal alpha cohort. Drifted comments are visibly handled. Known canvas limitation is surfaced in product copy.

## Build order

Strict order:
1 → 2 → 3 → 4 → 5 → 6 → 7

No internal parallelism is assumed. The two-person team noted in the original PRD milestones can parallelize within a sub-project (frontend + backend split, for example), but each sub-project's exit criteria must be met before the next one starts so that we never have to revise an interface in flight.

## Decision snapshot

The 14 refinement decisions locked on 2026-05-12 before this decomposition was written. All are incorporated into the PRD; this table is for traceability.

| # | Topic | Decision |
|---|---|---|
| 1 | Goals / non-goals | Final, no changes |
| 2 | Sanitization | Strip nested `<iframe>` and `<meta http-equiv="refresh">` only |
| 3 | Version permissions | Uploader-only (add-version, delete, metadata edit) |
| 4 | Sync model | 10s polling, foreground only, conditional requests |
| 5 | CDN allowlist | PRD list + `esm.sh` + `cdn.skypack.dev` |
| 6 | Other CSP directives | `connect-src 'none'`; `img-src data: blob: 'self' https:`; `form-action 'none'` |
| 7 | Comment edits | Unlimited, "edited" indicator |
| 8 | Canvas | Comment on element whole; document as v1 limitation |
| 9 | Refinement scope | Full pass through all listed and discovered gaps |
| 10 | Iframe popups | Drop `allow-popups` + `allow-popups-to-escape-sandbox`; companion script forwards external nav to parent |
| 11 | Resolved-thread reply | Auto-reopens the thread |
| 12 | Notification rules | Skip self-mentions, fire on edit-add (not edit-remove), no rate limiting in v1 |
| 13 | Metadata edits | Uploader can edit title, description, version notes; no history |
| 14 | UI defaults | 30d recently-viewed (uncapped); recently-deleted section; 360px right sidebar (collapsible); upload-time HTML parse validation |
| 15 | Decomposition shape | Phase 1 (4 sub-projects local-first) + Phase 2 (3 sub-projects); start at sub-project 1 |

## Next step

Open a new session and brainstorm sub-project 1 (Local foundation) through the normal design flow. Major sub-project-1 decisions to expect: framework choice (Next.js vs Hono vs a Bun-native option), Postgres access pattern, local object-storage layout, exact shape of mock-user middleware, migration tool.
