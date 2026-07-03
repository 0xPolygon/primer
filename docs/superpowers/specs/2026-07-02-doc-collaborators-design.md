# Doc Collaborators — Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-07-02
**Status:** Draft
**Issue:** [#29](https://github.com/0xPolygon/primer/issues/29)

## Purpose

Today every Primer document has exactly one owner (the uploader) and the read model is share-by-URL: any authenticated Polygon user can read any document; only the owner can mutate it. Issue #29 asks for two capabilities on top of that:

1. **Collaborators.** Grant specific users write access, or (under a private doc) comment access, to a doc they don't own.
2. **Private visibility.** Restrict a doc to owner + collaborators, hiding it from the rest of the org.

This spec captures the full feature (data model, permission semantics, wire-through, UX shape) and then decomposes it into four independently-shippable sub-issues so we can ship it as a stack of small PRs rather than one large change.

## Non-goals

- **Ownership transfer.** Adding, changing, or removing the owner. Out of scope for #29; file a follow-up if it becomes a real need.
- **Group / team collaborators.** Collaborators are individual Polygon users only.
- **External / non-org collaborators.** Everyone is a Polygon Okta user; no invite-by-email flow, no pending invites.
- **Per-version collaborators.** Permissions attach to the document, not to individual versions.
- **Audit log of permission changes.** Nice-to-have; not in scope.
- **Ownership by anyone other than the uploader.** `documents.uploaderId` stays authoritative for "owner."
- **MCP tools for collaborator management.** MCP tools honor permissions (that's mandatory) but the *management* surface is UI + HTTP API only for now.
- **Slack notification** when you're added as a collaborator. Email is in scope (see [Notifications](#notifications)); Slack is a natural follow-up but not part of #29.
- **Notification on collaborator role change or removal.** Only *add* triggers an email in this scope.

## Roles and visibility

### Roles

Two collaborator roles, matching the wording of #29:

- **`commenter`** — read + comment on the doc.
- **`editor`** — read + comment + write (edit title/description, add versions, edit version notes).

The document's **owner** is always full-access (read/comment/write plus the permission-management surface). Owner is not a row in the collaborators table — it's derived from `documents.uploaderId`.

### Visibility

Two states on the document:

- **`org`** *(default, matches today's behavior)* — any authenticated Polygon user can read + comment. Only owner and editor collaborators can write.
- **`private`** — only owner + collaborators (both roles) can read. Only owner + editor collaborators can write. All other users are denied — including on the doc-view route, MCP reads, and any list surfaces.

### Permission matrix

| Actor \ visibility     | `org` (default)                                  | `private`                                        |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Owner                  | read + comment + write + manage                  | read + comment + write + manage                  |
| Editor collaborator    | read + comment + write                           | read + comment + write                           |
| Commenter collaborator | *(redundant — org grants this)*                  | read + comment                                   |
| Any other authed user  | read + comment                                   | **no access**                                    |

"Manage" = add/remove collaborators, change collaborator role, change doc visibility. Manage is **owner-only**. Editors can write content but cannot re-grant access.

### Role validation rules

The interaction between visibility and role has a couple of policies worth stating explicitly:

- **Adding a `commenter` under `org` visibility is disallowed at the API layer.** Under `org` visibility every authed user already has read + comment, so a commenter row is a no-op. The API rejects it (`400 invalid_role_for_visibility`) so the state stays honest.
- **Adding an `editor` is allowed under both visibility states.** Editor grants write, which org visibility does not.
- **Flipping visibility `private` → `org` while `commenter` rows exist:** the rows are **preserved** (not deleted). They become inert while visibility is `org` (they grant no more access than the org already has) and re-activate if the owner flips back to `private`. This is the least-surprising, non-destructive rule: no accidental data loss, no forced UX flow at the moment of flipping.
- **Flipping visibility `org` → `private`:** no data change. Existing editor rows remain editors; the doc becomes hidden from non-collaborators immediately.
- **Owner cannot be added as their own collaborator.** API rejects it (`400 owner_not_collaborator`).
- **Same user cannot appear twice.** Unique constraint on `(document_id, user_id)`.

## Data model

### `documents` — new column

Add one column to the existing `documents` table:

- `visibility` — enum `'org' | 'private'`, `NOT NULL`, default `'org'`.

All existing rows default to `'org'`, which is behaviorally identical to today. No data migration required.

### `document_collaborators` — new table

```
document_collaborators
├─ id             UUID  PK
├─ document_id    UUID  FK → documents.id, ON DELETE CASCADE
├─ user_id        UUID  FK → users.id,     ON DELETE CASCADE
├─ role           TEXT  NOT NULL, CHECK (role IN ('commenter', 'editor'))
├─ granted_by     UUID  FK → users.id  -- audit trail; who added them
├─ created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
├─ UNIQUE (document_id, user_id)
└─ INDEX (user_id)  -- for "shared with me" queries
```

Notes:
- `ON DELETE CASCADE` on both FKs: if a document is hard-deleted, its collab rows go with it; same for a user (matches existing FK behavior on other tables that reference `users`).
- No soft-delete on collaborator rows. Removing a collaborator is a hard delete — no need for a `deletedAt` here.
- `granted_by` stores the owner at the time of grant. Useful for observability and any future audit view; not exposed on read APIs in this scope.

### No changes to

- `versions`, `threads`, `comments`, `sessions`, `users`, `document_views` — none of these carry ownership; the permission model derives everything from `documents` + `document_collaborators`.

## Permission core

### Central helpers

All permission checks route through a single module (`apps/api/src/lib/permissions.ts`). The public surface:

```ts
canRead(doc, user): boolean
canComment(doc, user): boolean
canEdit(doc, user): boolean         // owner or editor
canManage(doc, user): boolean       // owner only
```

Each helper receives the document row (which now carries `visibility` and `uploaderId`) plus a *resolved* collaborator role for the current user (`undefined` if none). Callers preload the collaborator row (a single `SELECT ... WHERE document_id = ? AND user_id = ?`) alongside the document; the helpers themselves are pure.

For batch surfaces (listing docs on the home page), a bulk variant preloads collaborator rows in one query keyed by `user_id` + `document_id IN (...)`.

### Wire-through — what changes

Every existing read/write/comment path that currently either (a) has no check or (b) does an inline `uploaderId === user.id` check gets routed through the helpers.

**HTTP routes (`apps/api/src/routes/`):**

- `GET /api/documents/:docId` → `canRead`
- `PATCH /api/documents/:docId` → dispatch by body: if the body includes `visibility` (or any other manage-only field), the request must pass `canManage`; if the body only touches `title` / `description`, `canEdit` is sufficient. A body that mixes both is treated as a manage request.
- `DELETE /api/documents/:docId` → owner-only (unchanged — checked via `canManage` or explicit owner check)
- `POST /api/documents/:docId/versions` → `canEdit`
- `PATCH /api/versions/:versionId` → `canEdit` on the parent doc
- Thread + comment routes → `canComment` for create; `canRead` for read

**MCP tools (`apps/api/src/mcp/tools.ts`):**

- `primer_get_document` → `canRead`
- `primer_get_version_content` → `canRead`
- `primer_list_versions` → `canRead`
- `primer_get_comments` → `canRead`
- `primer_add_version` → `canEdit`
- `primer_create_document` → no change (creator becomes owner)
- `primer_resolve_url`, `primer_whoami` → no change

**List surfaces:**

- Home page's "My documents" list is unchanged (already filters on `uploaderId`).
- Home page's "Recently viewed or commented" list must filter out private docs the user can neither own nor collaborate on. (A user shouldn't see a row for a private doc they've been un-collaborated from, even if they viewed it in the past.)

### Behavior parity

Existing docs default to `visibility='org'` with an empty `document_collaborators` table. Under the new helpers, this produces exactly today's behavior for every existing row:

- Owner → full access (unchanged).
- Any authed user → read + comment via the `org` visibility branch.
- Non-owner writes → denied.

Sub-issue 1 is therefore behavior-preserving on ship. Sub-issues 2–4 enable the new capabilities.

## Notifications

When a user is added as a collaborator, we send them a one-off email so they know the doc exists and can find it.

### Trigger

Only on **add**. Role changes (commenter → editor and vice versa) and removals do **not** trigger email. Follow-up issues can revisit if the pattern justifies it.

If the added user is the same as the actor (self-add), the email is **suppressed**. The API already rejects owner-adds-self, but we suppress at the notifier layer as a belt-and-braces policy so this doesn't have to be re-thought if that validation rule ever changes.

### Interface

Extend the existing `Notifier` abstraction (`apps/api/src/notifications/notifier.ts`) with one new method, mirroring the shape of `notifyComment`:

```ts
notifyCollaboratorAdded({
  docId: string;
  docTitle: string;
  addedUserId: string;
  addedByUserId: string;
  role: 'commenter' | 'editor';
}): Promise<void>
```

- **`NoopNotifier`** — no-op, same as its `notifyComment` implementation.
- **`MailgunNotifier`** — one email to the added user's `users.email`. Subject `You were added to "<docTitle>" on Primer`. Body includes the role, who added them (`users.displayName`), and a link to the doc (`<AUTH_BASE_URL>/d/<docId>`). Plaintext + HTML, same rendering approach as the existing comment notification path.
- Self-suppression is enforced in the *notifier implementations*, not at the call site, so it's a single place regardless of how many call sites exist in the future.

### Call site

Fire-and-forget after a successful commit inside `POST /api/documents/:docId/collaborators`. Matches the fire-and-forget pattern used by the thread/comment routes for `notifyComment`. A notifier failure never fails the HTTP request; it's logged.

### Delivery in prod

Whether an email actually goes out is a config concern — `buildNotifier()` picks `MailgunNotifier` when `MAILGUN_API_KEY`, `EMAIL_FROM`, `AUTH_BASE_URL`, and `MAILGUN_DOMAIN` (or an inferable domain) are set; otherwise it falls back to `NoopNotifier`. The wiring is code-complete regardless of whether the env is provisioned. Provisioning is outside the scope of this spec.

## Sub-issue decomposition

Four sub-issues, ordered by dependency. Each is one session-sized unit and ships as its own PR under #29 as the tracking issue.

### Sub 1 — Permission core (behavior-preserving foundation)

**Scope:**
- Schema: add `documents.visibility` column with `'org'` default; add `document_collaborators` table (both migrations).
- Add `apps/api/src/lib/permissions.ts` with `canRead` / `canComment` / `canEdit` / `canManage` plus bulk variants.
- Route every existing HTTP route and MCP tool listed above through the helpers. Remove inline `uploaderId === user.id` checks in favor of `canEdit` / `canManage`.
- Filter "Recently viewed or commented" on the home page by `canRead`.
- Unit tests for the helpers covering the permission matrix; integration tests confirming existing routes behave identically for the default `org` + empty-collab state.

**Depends on:** —

**Exit criteria:** Migrations applied, all existing tests still pass, new helper tests + integration tests green. No user-visible behavior change on `main` after this ships — the new capabilities aren't reachable yet because the management surface doesn't exist.

**Deferred:** collaborator management API, visibility toggle API, all UI, "Shared with me" dashboard surface.

### Sub 2 — Collaborator + visibility management API

**Scope:**
- `GET    /api/documents/:docId/collaborators` — list, owner-only.
- `POST   /api/documents/:docId/collaborators` — add, owner-only. Body: `{ userId, role }`. Enforces the role-validation rules from this spec (no owner-as-collaborator; no `commenter` under `org`; no duplicates).
- `PATCH  /api/documents/:docId/collaborators/:userId` — change role, owner-only. Same validation.
- `DELETE /api/documents/:docId/collaborators/:userId` — remove, owner-only.
- Extend `PATCH /api/documents/:docId` to accept `visibility`; owner-only via `canManage`.
- User-search endpoint scoped to typeahead: `GET /api/users?q=<name-prefix>&docId=<uuid>` — returns up to 20 Polygon users matching a display-name prefix, minus the current owner and any existing collaborators of that doc when `docId` is provided. Used by the Sub 3 modal.
- Extend the `Notifier` interface with `notifyCollaboratorAdded(...)` per the [Notifications](#notifications) section; update `NoopNotifier` and `MailgunNotifier`; fire fire-and-forget from the add endpoint after commit.
- Tests: owner-only enforcement, role-vs-visibility validation, dup/self-collab rejection, typeahead behavior; a `NotifierSpy` covers "add fires exactly once with the right args," "role change and remove do not fire," and "self-add is suppressed at the notifier layer."

**Depends on:** Sub 1.

**Exit criteria:** New endpoints tested; visibility toggle works through the existing PATCH; existing UI/UX unaffected (no consumer yet). All permission enforcement flows through Sub 1's helpers. `notifyCollaboratorAdded` is invoked from the add endpoint and covered by spy-based tests; actual email delivery is gated on the existing Mailgun config.

**Deferred:** UI, dashboard integration, MCP tools for collaborator management, email on role change / removal, Slack delivery.

### Sub 3 — Sharing UI

**Scope:**
- "Share" affordance on the doc view (owner-only), opening a modal that shows:
  - Current visibility (`org` / `private`) as a toggle. Warns when flipping to `private` if the doc has recent viewers who aren't collaborators (soft warning, not a block).
  - Current collaborators, each with role dropdown (`commenter` / `editor`) and remove button. The `commenter` option is disabled with a tooltip when visibility is `org`.
  - Typeahead search over Polygon users (uses the Sub 2 endpoint) to add a new collaborator, with an inline role picker before "Add."
- Non-owners see a read-only "Shared with … + N others" indicator on the doc header when they are a collaborator; no modal, no controls.
- Uses only Sub 2's API surface. No new endpoints in this sub-issue.
- Tests: modal open/close, role dropdown behavior tied to visibility, typeahead filtering out existing collaborators, error surfacing.

**Depends on:** Sub 2.

**Exit criteria:** An owner can share a doc, add and remove collaborators of both roles, and toggle visibility entirely from the doc view. Non-owner UI clearly reflects the permission state.

**Deferred:** dashboard integration (Sub 4), Slack notifications of new collaborator (follow-up issue).

### Sub 4 — Dashboard integration

**Scope:**
- "Shared with me" section on the home page: docs where the current user has a `document_collaborators` row (either role). Sorted most-recent-first by grant time.
- Visibility indicator on doc rows across the dashboard (small badge / icon for `private`).
- Confirm existing lists correctly hide private docs the current user can't read (already handled by Sub 1's filter on "Recently viewed"; this sub-issue verifies + adds coverage for any list surface introduced meanwhile).
- Tests: home-page snapshot + integration tests that a user with a `private` collab row sees it in "Shared with me"; a user without one does not.

**Depends on:** Sub 1 (data model + permission helpers). Independent of Sub 2/3 for backend, but ships after Sub 3 in practice so the full flow is user-testable end to end.

**Exit criteria:** Users can discover docs shared with them from the home page; private docs are visually distinct; no private docs leak into a viewer without a collab row.

**Deferred:** advanced filters (by shared/private/mine) — punt to a general dashboard-organization pass (that's what #28 is about).

## Testing strategy

- **Unit tests** for `permissions.ts` covering the permission matrix exhaustively (owner / editor / commenter / stranger × `org` / `private` × read / comment / edit / manage).
- **Integration tests** at the HTTP layer confirming each affected route returns 200/403 as expected under all matrix positions.
- **MCP tool tests** mirroring the HTTP integration tests through the tool surface.
- **UI tests** in Sub 3/4 focus on the state transitions that are easy to get wrong: role dropdown grayed under `org`, "Shared with me" empty state, private-visibility badge.

## Migration + rollout

- Sub 1 ships behind no flag. Its migrations are additive (one nullable-defaulted column + one new table); no data migration required.
- Because Sub 1 is behavior-preserving, it can ship to `master` (auto-deploys to Railway) at any time.
- Subsequent sub-issues are also independent: each one is user-invisible except through its own new surface. There is no cross-sub-issue rollout coupling.

## Open questions

None outstanding at spec time. Interaction rules (visibility × role) are pinned in the "Role validation rules" section; edge cases (owner-as-collaborator, dup rows, visibility-flip with commenters) are pinned there as well.

## References

- Issue [#29 — Support collaborators for docs](https://github.com/0xPolygon/primer/issues/29)
- Existing decomposition precedent: `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
- Current auth model: `apps/api/src/middleware/auth.ts`
- Current permission checks (all owner-only, all inline): `apps/api/src/routes/documents.ts`, `apps/api/src/routes/versions.ts`, `apps/api/src/mcp/tools.ts`
- Current schema: `packages/shared/src/schema.ts`
- Existing notifier abstraction: `apps/api/src/notifications/notifier.ts`, `apps/api/src/notifications/mailgun.ts`, `apps/api/src/notifications/index.ts`
