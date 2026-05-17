# Sub-project 4 — Versioning + soft-delete: Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-05-17
**Status:** Approved for implementation planning
**Parent PRD:** `docs/prd-primer.md`
**Parent decomposition:** `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
**Predecessors:**
- `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md` (SP1, shipped)
- `docs/superpowers/specs/2026-05-13-primer-anchoring-companion-design.md` (SP2, shipped)
- `docs/superpowers/specs/2026-05-16-primer-comments-threading-design.md` (SP3, shipped)

## Purpose

SP4 closes Phase 1 by adding the lifecycle pieces the artifact pipeline has been missing: multiple versions per document, an "add a new version" flow that increments `version_number` atomically, a version selector and a version-pinned URL, a read-mostly mode when viewing an older version, metadata editing for uploaders, soft-delete with a 30-day reversible window, and a hard-purge job that finally drops expired soft-deleted docs from the DB and storage.

The form-design polish — a new `FileDropZone` component shared by the existing standalone `UploadPage` and the new `AddVersionModal` — is in-scope per user direction during brainstorming. The current default `<input type="file">` is ugly and hard to use; replacing it with a drag-and-drop dropzone is a small lift that meaningfully improves both flows.

After SP4 ships, the Phase 1 app is feature-complete. Phase 2 (Okta auth, Slack notifications, alpha launch polish) follows.

## Scope summary

**In scope:**

- **API:** four new uploader-only endpoints under `/api/documents/:docId` (PATCH, DELETE, POST `/restore`, POST `/versions`), a list-versions endpoint, a version-note PATCH at `/api/versions/:vid`, plus modifications to existing GET `/api/documents/:docId` (404 on soft-delete), POST `/api/versions/:vid/threads` (409 on non-latest), and GET `/api/dashboard` (adds `recentlyDeleted`).
- **Frontend:** `VersionSelector`, `AddVersionModal`, `FileDropZone`, `EditableField`, `RestoreButton`. `DocumentPage` extended with version-pinned routing, read-mostly mode, inline metadata editing, and the new uploader-only action buttons. `HomePage` gains a collapsed "Recently deleted" section. `UploadPage` adopts the new `FileDropZone`.
- **Purge job:** `purgeExpiredDocuments()` function plus two invocation paths (in-process interval started by `index.ts`, and a `pnpm db:purge` CLI script).
- **Tests:** new Vitest coverage for every API change, every dashboard scenario, and the purge function.

**Out of scope (deferred to later sub-projects):**

- Slack notification on new-version creation (sub-project 6).
- Version diff / "what changed" view (PRD non-goal).
- Comment reactions, emoji, rich text (PRD non-goal).
- Page-level Recently-deleted route (could land in SP7 polish if power users want it).
- Real Okta auth — uploader-only checks here use the SP1 mock-user middleware. SP5 swaps the middleware for real Okta resolution; the authorization predicate (`documents.uploader_id === user.id`) doesn't change.

## Stack notes

No new runtime dependencies. Existing schema columns cover everything:
- `documents.deletedAt` (timestamp, nullable) — soft-delete marker.
- `documents.title`, `documents.description` — PATCH targets.
- `versions.versionNumber` (integer) with unique index on `(documentId, versionNumber)` — race protection for add-version.
- `versions.versionNote` (text, nullable) — PATCH target.

No SQL migration in this sub-project.

The standard SP1 + SP3 storage interface (`Storage.put/get/delete`) is reused for the purge job's file removal step.

## File map

```
apps/api/src/
  routes/
    documents.ts          # MOD — soft-delete 404, PATCH, DELETE, restore,
                          #        add-version, list-versions
    documents.test.ts     # MOD — new cases for each
    versions.ts           # NEW — PATCH version-note
    versions.test.ts      # NEW
    threads.ts            # MOD — 409 on POST to non-latest version
    threads.test.ts       # MOD
    dashboard.ts          # MOD — adds recentlyDeleted section
    dashboard.test.ts     # MOD
  jobs/
    purge.ts              # NEW — purgeExpiredDocuments + startPurgeInterval
    purge.test.ts         # NEW
    purge-cli.ts          # NEW — pnpm db:purge entry
  index.ts                # MOD — call startPurgeInterval()
  package.json            # MOD — db:purge script

apps/web/src/
  components/
    FileDropZone.tsx      # NEW — shared drag/drop dropzone
    AddVersionModal.tsx   # NEW
    VersionSelector.tsx   # NEW
    EditableField.tsx     # NEW
    RestoreButton.tsx     # NEW
    DocumentListRow.tsx   # MOD — DeletedDocumentRow variant
  queries/
    versions.ts           # NEW — useVersionsQuery, useAddVersion,
                          #        useEditVersionNote
    documents.ts          # MOD — useEditDocument, useDeleteDocument,
                          #        useRestoreDocument
    dashboard.ts          # MOD — DashboardResponse uses new shape
  routes/
    upload.tsx            # MOD — uses FileDropZone, layout polish
    document.tsx          # MOD — version selector, read-mostly mode,
                          #        inline editing, action buttons
    home.tsx              # MOD — Recently deleted section,
                          #        Add new version entry
  App.tsx                 # MOD — adds /d/:docId/v/:versionNumber route

packages/shared/src/
  api.ts                  # MOD — new DTOs
```

Root `package.json` also adds a `db:purge` passthrough script.

## Architecture overview

```
┌─────────────────────── apps/web ────────────────────────────────┐
│                                                                  │
│  HomePage                                                        │
│    ├─ "+ Upload document"  (existing)                            │
│    ├─ "+ Add new version"  NEW — opens AddVersionModal           │
│    ├─ My documents         (existing)                            │
│    ├─ Recently viewed      (existing)                            │
│    └─ Recently deleted     NEW — collapsed by default;           │
│                             uploader's soft-deleted docs in 30d  │
│                                                                  │
│  DocumentPage (modified)                                         │
│    ├─ Header                                                     │
│    │   ├─ title  (EditableField, uploader-only)                  │
│    │   ├─ description  (EditableField, uploader-only)            │
│    │   ├─ VersionSelector  NEW                                   │
│    │   ├─ Pick element button (hidden when read-mostly)          │
│    │   ├─ + Version  (uploader-only) → AddVersionModal           │
│    │   └─ ⋯ menu (uploader-only) → Delete document               │
│    ├─ Read-mostly banner   (shown when currentVersionId !=       │
│    │                        latestVersionId)                     │
│    ├─ ArtifactIframe        (unchanged)                          │
│    └─ CommentSidebar                                             │
│         composer slot suppressed when read-mostly;               │
│         existing threads remain fully interactive                │
│                                                                  │
│  UploadPage (modified)                                           │
│    Reordered fields, FileDropZone replaces the default           │
│    <input type="file">                                           │
│                                                                  │
│  AddVersionModal (NEW)                                           │
│    Doc combobox (pre-filled or typeahead), FileDropZone,         │
│    version note, submit → POST /api/documents/:docId/versions    │
│                                                                  │
│  /d/:docId          → renders latest version (existing route)    │
│  /d/:docId/v/:N     NEW route, same component, pins version N    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                          REST endpoints
                              │
┌─────────────────────── apps/api ─────────────────────────────────┐
│                                                                  │
│  routes/documents.ts                                             │
│    GET    /:docId                  404 when deletedAt set        │
│    PATCH  /:docId                  uploader edits title/desc     │
│    DELETE /:docId                  soft-delete                   │
│    POST   /:docId/restore          clear deletedAt within 30d    │
│    POST   /:docId/versions         add new version (multipart)   │
│    GET    /:docId/versions         list versions                 │
│                                                                  │
│  routes/versions.ts (NEW)                                        │
│    PATCH /api/versions/:vid        edit version_note             │
│                                                                  │
│  routes/threads.ts (MOD)                                         │
│    POST /api/versions/:vid/threads guards: 409 if not latest     │
│                                                                  │
│  routes/dashboard.ts (MOD)                                       │
│    GET /api/dashboard              adds recentlyDeleted[]        │
│                                                                  │
│  jobs/purge.ts (NEW)                                             │
│    purgeExpiredDocuments(deps)                                   │
│    startPurgeInterval(deps)                                      │
│                                                                  │
│  jobs/purge-cli.ts (NEW)                                         │
│    Entry for `pnpm db:purge`                                     │
│                                                                  │
│  index.ts (MOD)                                                  │
│    startPurgeInterval({ storage })  default 1h, configurable     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Data shape notes (no migration)

Every SP4 requirement uses columns that already exist from SP1.

- **`documents.deletedAt`** — `null` for live docs, ISO timestamp when soft-deleted. The 30-day purge and restore windows are measured from this value via a shared `RESTORE_WINDOW_DAYS = 30` constant in `apps/api/src/jobs/purge.ts`.
- **`documents.title` / `documents.description`** — PATCH'd by the new edit endpoint. No history table (PRD).
- **`versions.versionNumber`** — uniquely indexed on `(documentId, versionNumber)`. Race protection is built into the constraint: a concurrent add-version produces `23505 unique_violation`, which the route translates to `409 version_race` so the client retries with a fresh `max + 1`.
- **`versions.versionNote`** — `text` nullable. PATCH'd by version-note edit endpoint.

### Soft-delete cascade

The existing FK cascades (`versions → threads → comments → comments cascade`, `versions ON DELETE CASCADE documents`, `document_views ON DELETE CASCADE documents`) are **hard-delete** cascades. Soft-deletion sets `documents.deletedAt` and **does not touch any other table**. The hard-purge job is the only thing that runs `DELETE FROM documents WHERE …` and lets the FK cascade do its work.

### Visibility rules (server-enforced)

Every read query against documents adds these guards:

| Endpoint | Rule when `deletedAt IS NOT NULL` |
|---|---|
| `GET /api/documents/:docId` | `404 not_found` for everyone, including the uploader. Uploaders interact with soft-deleted docs only via the home-page "Recently deleted" list and the restore endpoint. |
| `GET /api/versions/:vid/content` | `404 not_found` if the version's parent doc is soft-deleted. |
| `GET /api/versions/:vid/threads` | `404 not_found` if the version's parent doc is soft-deleted. Polling stops cleanly. |
| `GET /api/documents/:docId/versions` | `404 not_found` if the doc is soft-deleted. |
| `POST /api/versions/:vid/threads` | `404` if doc soft-deleted; `409 not_latest_version` if `vid` is not the doc's latest version. |
| `GET /api/dashboard` | `myDocuments` and `recentlyViewedOrCommented` already exclude soft-deleted (SP3); new `recentlyDeleted` lists ONLY soft-deleted within 30 days, scoped to the requester. |

## API surface

### `GET /api/documents/:docId` (MOD)

Already exists from SP1. Adds: returns `404 { error: 'not_found' }` when `documents.deletedAt IS NOT NULL`. The view-tracking upsert (added in SP3) is skipped for soft-deleted requests — there's no "view" to track for a doc the user can't see.

### `PATCH /api/documents/:docId` (NEW)

**Auth:** uploader-only. `403 forbidden` otherwise.

**Body:** `DocumentPatchRequest`

```ts
{
  title?: string;             // 1–200 chars after trim, if present
  description?: string | null; // ≤2000 chars, null clears
}
```

Both fields optional individually, but the request must include at least one. Empty body → `400 invalid_body`.

**Behavior:**
- 404 if soft-deleted (PATCH on a soft-deleted doc is meaningless; uploader must restore first).
- Updates the named fields, leaves others untouched. No history table.
- No notification (metadata edits are uploader-only and don't fan out).

**Response:** `200` with the updated `DocumentSummary` (existing SP1 shape).

### `DELETE /api/documents/:docId` (NEW)

**Auth:** uploader-only. `403 forbidden` otherwise.

**Behavior:**
- Sets `deletedAt = now()`. Idempotent — deleting an already-deleted doc returns the existing tombstone.
- Threads/comments/versions are untouched (soft-delete only).

**Response:** `200 { id: string; deletedAt: string }`.

### `POST /api/documents/:docId/restore` (NEW)

**Auth:** uploader-only. `403 forbidden` otherwise.

**Behavior:**
- If `deletedAt IS NULL` → idempotent `200` with the doc.
- If `deletedAt` is ≤30 days old → clears `deletedAt` and `200` with the restored `DocumentSummary`.
- If `deletedAt` is >30 days old → `409 restore_window_expired` (regardless of whether the purge has actually run yet — contract first).

### `POST /api/documents/:docId/versions` (NEW)

**Auth:** uploader-only. `403 forbidden` otherwise.

**Body:** `multipart/form-data`, fields:
- `file` — the `.html` file, required.
- `versionNote` — string ≤500 chars, optional. Empty after trim is normalized to `null`.

**Behavior:**
- 404 if doc soft-deleted.
- Runs the same validate → parse5 → sanitize → inject companion → store pipeline as the SP1 `POST /api/upload` route. Reuse `transformHtml` + `validateUpload` directly.
- Inside a transaction: SELECT `MAX(version_number)` for the doc, INSERT new row with `versionNumber = max + 1`. The unique index on `(documentId, versionNumber)` is the race backstop — a concurrent insert produces `23505`, translated to `409 version_race`. Client may retry.
- No notification in SP4 (the cross-version Slack ping is SP6 territory).

**Response:** `201 AddVersionResponse`:

```ts
{
  versionId: string;
  versionNumber: number;
  url: string;   // /d/:docId — the new version is implicitly latest
}
```

### `GET /api/documents/:docId/versions` (NEW)

**Auth:** any signed-in user.

**Behavior:**
- 404 if doc soft-deleted.
- Returns all versions ordered by `versionNumber DESC`. No pagination (PRD: "no enforced limit at launch; monitor and revisit").

**Response:** `200 VersionsListResponse`:

```ts
{
  versions: VersionSummaryDTO[];   // existing SP1 DTO, version-pinned URL not included
}
```

`VersionSummaryDTO` shape:

```ts
{
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;  // ISO
}
```

### `PATCH /api/versions/:vid` (NEW)

**Auth:** uploader of the parent doc. `403 forbidden` otherwise.

**Body:** `VersionPatchRequest`:

```ts
{
  versionNote: string | null;   // null clears; empty string normalized to null
}
```

If `versionNote` is a non-null string, trim and reject >500 chars as `400 invalid_body`.

**Behavior:** updates `versions.versionNote`. 404 if the version's parent doc is soft-deleted.

**Response:** `200 VersionSummaryDTO`.

### `POST /api/versions/:vid/threads` (MOD)

Existing SP3 endpoint. SP4 adds a guard at the top of the handler:

- If `vid` is not the latest version of its parent doc → `409 not_latest_version`.

The check is one query: `SELECT MAX(version_number) FROM versions WHERE document_id = (SELECT document_id FROM versions WHERE id = $vid)` compared to the requested version's number. Cheap; runs before any insert.

### `GET /api/dashboard` (MOD)

`DashboardResponse` gains a third field:

```ts
{
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
  recentlyDeleted: DeletedDocumentEntry[];   // NEW
}
```

`DeletedDocumentEntry` shape:

```ts
{
  id: string;
  title: string;
  deletedAt: string;        // ISO
  daysRemaining: number;    // ceil(30 - daysSinceDeleted), clamped [0..30]
}
```

**`recentlyDeleted` query:**

```sql
SELECT id, title, deleted_at,
       GREATEST(0, 30 - EXTRACT(DAY FROM now() - deleted_at)::int) AS days_remaining
FROM documents
WHERE uploader_id = $1
  AND deleted_at IS NOT NULL
  AND deleted_at > now() - interval '30 days'
ORDER BY deleted_at DESC
```

Excludes docs already past the 30-day window (those are awaiting purge or already purged).

## Purge job

### `purgeExpiredDocuments`

`apps/api/src/jobs/purge.ts`:

```ts
export const RESTORE_WINDOW_DAYS = 30;

export interface PurgeReport {
  purgedDocumentIds: string[];
  purgedStorageKeys: string[];
  failedStorageKeys: { key: string; error: string }[];
  durationMs: number;
}

export async function purgeExpiredDocuments(deps: {
  storage: Storage;
}): Promise<PurgeReport>;
```

**Behavior:**

1. SELECT all `documents` with `deletedAt IS NOT NULL AND deletedAt < now() - interval '30 days'`. Order by `deletedAt ASC` so the oldest go first.
2. For each candidate, in its own transaction:
   - Collect every `storage_key` from `versions WHERE document_id = $1`.
   - Delete the storage files first via `storage.delete(key)`. Failures are logged + recorded in `failedStorageKeys`; do **not** abort the doc purge — orphaned files are recoverable on the next run, but a half-purged DB is messier than a half-purged storage tree.
   - `DELETE FROM documents WHERE id = $1`. FK cascade removes `versions`, `threads`, `comments`. `document_views` cascades via its own FK.
3. Return the report.

**Idempotence:** the predicate `deletedAt < now() - 30 days` is stable across rows; concurrent runs would attempt the same `DELETE` and the second one becomes a no-op. The function is naturally idempotent. No advisory lock needed.

### Interval starter

```ts
export function startPurgeInterval(deps: {
  storage: Storage;
  intervalMs?: number;
}): () => void;
```

- Default `intervalMs = 60 * 60 * 1000` (1 hour). Override via env var `PURGE_INTERVAL_MS` (read in `index.ts`).
- First tick fires `intervalMs` after process start, NOT immediately. Keeps boot uncoupled from purge.
- Returns a teardown function (wraps `clearInterval`) so tests can stop the timer. `index.ts` wires it to `SIGTERM` for clean shutdown.

`apps/api/src/index.ts`:

```ts
const stopPurge = startPurgeInterval({ storage });
process.on('SIGTERM', () => { stopPurge(); /* existing teardown */ });
process.on('SIGINT', () => { stopPurge(); process.exit(0); });
```

### CLI script

`apps/api/src/jobs/purge-cli.ts`:

```ts
import './env.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { purgeExpiredDocuments } from './purge.ts';
import { logger } from '../logger.ts';

const storage = new FilesystemStorage(process.env.STORAGE_ROOT ?? './storage');
const report = await purgeExpiredDocuments({ storage });
logger.info({ report }, 'purge-cli complete');
process.exit(report.failedStorageKeys.length > 0 ? 1 : 0);
```

Exposed via `apps/api/package.json`:

```json
"db:purge": "tsx src/jobs/purge-cli.ts"
```

And mirrored at the repo root:

```json
"db:purge": "pnpm --filter @primer/api run db:purge"
```

Non-zero exit when any storage delete failed, so a future CI/cron can detect partial failures.

## Frontend behavior details

### `FileDropZone`

Shared component used by `UploadPage` and `AddVersionModal`. Detailed during brainstorming — full design notes follow.

**Empty state:**
- Dashed-border rounded box, full form width, ~140px tall, centered content.
- Lucide-style upload icon (24px) on top.
- Primary line: **"Drop an HTML file here, or click to browse"** (medium weight).
- Secondary line, smaller and muted: **"`.html` files up to 10 MB"**.
- The whole box is the click target; clicking triggers a hidden `<input type="file" accept=".html,text/html">`.
- On drag-enter: border darkens, background tints subtly yellow (matches existing accent), primary line becomes **"Drop to attach"**.
- On drag-leave / drag-end: reverts.

**Selected state:**
- Same box (no height jump) but laid out: file icon left, filename primary + size muted ("142 KB") below, **"Replace"** link button right.
- Clicking "Replace" reopens the file picker.

**Inline validation** runs at file pick:
- Over 10 MB → red border, muted line becomes red: **"This file is 12.4 MB — limit is 10 MB."** Submit disabled.
- Wrong extension → red border, **"Only `.html` files are accepted."** Submit disabled.

**API errors** after submit render in the same red text below the dropzone with a `[Retry]` button.

**Accessibility:** `role="button"` + `tabindex="0"` + `aria-label="Upload HTML file"`. Responds to Enter/Space. Drag-over changes are paired with an `aria-live="polite"` announcement. Errors set `aria-invalid` and `aria-describedby`.

### `UploadPage` redesign

Single-column, ~480px max-width. Field order changes from SP1: dropzone first, then title, then description.

```
┌────────────────────────────────────────┐
│ Upload a document                      │
├────────────────────────────────────────┤
│   <FileDropZone />                     │
│                                        │
│   Title *                              │
│   [input]                              │
│                                        │
│   Description (optional)               │
│   [textarea]                           │
│                                        │
│        [ Cancel ]  [ Upload ]          │
└────────────────────────────────────────┘
```

Submit disabled until file present + title non-empty.

### `AddVersionModal`

Centered modal, ~520px wide, dimmed backdrop, ESC closes.

```
┌────────────────────────────────────────────┐
│  Add a new version                  [×]    │
│  ──────────────────────────────────────── │
│                                            │
│  Document                                  │
│  ┌────────────────────────────────────┐    │
│  │ Q1 retention deep-dive             ▾│    │
│  └────────────────────────────────────┘    │
│      v3 · last updated 2h ago              │
│                                            │
│  <FileDropZone />                          │
│                                            │
│  Version note (optional)                   │
│  [input]                                   │
│      e.g. "fixed Y-axis scale"             │
│                                            │
│      [ Cancel ]    [ Add version ]         │
└────────────────────────────────────────────┘
```

- **Trigger 1:** `+ Version` button in `DocumentPage` header (uploader-only). Doc is pre-filled and the combobox shows a tiny "← change document" link if the user wants to swap.
- **Trigger 2:** `+ Add new version` link in the `HomePage` chrome near `+ Upload document`. Combobox starts empty; typeahead over the user's own docs (uploader-only), sorted by recent activity, max 8 results, sourced from `GET /api/dashboard` (`myDocuments`).
- The line under the combobox shows the doc's current latest version + relative timestamp.
- Submit posts to `POST /api/documents/:docId/versions`. On success: modal closes, `useVersionsQuery(docId)` invalidates, navigate to `/d/:docId` (which renders the new latest).
- Submit shows "Adding…" + spinner while in flight; disabled until both doc + file are valid.

**Focus management:** modal traps focus; ESC dismisses; on close, focus returns to the launching button.

### `VersionSelector`

Dropdown placed in the `DocumentPage` header between the title block and the action buttons.

- **Closed state:** muted button text **"v3 · latest"** (or **"v2 of 4"** when pinned to a non-latest).
- **Open state:** menu ~280px wide. Each entry shows: version-number badge, version note (or *"no note"* in muted italic), relative time, uploader display name. The latest version has a small "LATEST" pill on the right. Currently-viewed version is highlighted.
- Clicking an entry navigates to `/d/:docId/v/:versionNumber`; clicking the latest navigates to `/d/:docId` (clean URL).
- Keyboard navigable (Enter/Space opens; arrow keys move; Enter selects; Esc closes).
- Backed by `useVersionsQuery(docId)`. No polling; refetch on window focus only. Add-version mutations invalidate this query.

### `EditableField`

Click-to-edit inline editor. Used for **document title**, **document description**, and **version note**.

- **Display mode:** value rendered as-is. When the current user is the uploader, a small pencil icon shows on hover; the whole row is clickable.
- **Edit mode:** display replaced with `<input>` (title, version note) or `<textarea>` (description). Autofocuses on entry. Saves on `Cmd/Ctrl+Enter` or on blur if changed. Cancels on `Esc`; restores prior value.
- **Empty state:** description and version note render as muted **"Add a description"** / **"Add a note"** placeholder text in display mode. Clicking enters edit mode with empty input. Saving an empty string normalizes to `null`.
- **Non-uploader view:** display mode only, no pencil, no click-to-edit.
- **Optimistic update** to cache; rollback with inline red toast for ~3s on error.

### Read-mostly banner

When `currentVersionId !== latestVersionId`:

```
⓵  You're viewing v2 of "Q1 retention deep-dive". This version is read-only.
   Switch to v3 (latest) to add new comments.   [ ▸ Switch to latest ]
```

- Yellow-50 background, yellow-200 border-bottom, ~6px padding.
- Button navigates to `/d/:docId`.
- Composer slot in `CommentSidebar` is suppressed entirely (parent passes `pending = null` permanently). Selection still gets captured by the companion but the parent ignores `selection_captured` / `element_picked` messages — no `pendingSelection` / `pendingPick` state set.
- "Pick element" button in the header is hidden in read-mostly mode.
- Existing threads render normally with full Reply/Resolve/Reopen/Edit/Delete actions (PRD's definition of "read-mostly").

### `DocumentPage` header (modifications)

```
┌──────────────────────────────────────────────────────────────────┐
│  Q1 retention deep-dive  ✎                  [ v3 · latest ▾ ]    │
│  Quarterly business review prep — March  ✎  [ Pick ] [ + Ver ]   │
│  Mock User · 2h ago                         [ ⋯ ]                │
└──────────────────────────────────────────────────────────────────┘
```

- Title is now an `EditableField` (uploader-only edit).
- Description is now an `EditableField`.
- Right side gains: `VersionSelector`, then **Pick element** (hidden when read-mostly), then **+ Version** (uploader-only), then **⋯** menu (uploader-only) with **Delete document**.
- Delete shows an inline confirmation popover: **"Delete this document? You can restore it within 30 days from the home page."** with `[Cancel]` and `[Delete]`. No global modal — popover anchored to the ⋯ button.

### `HomePage` — Recently deleted section

Below "Recently viewed or commented":

```
─ Recently deleted ─────────────────────────────────────────── ▸
```

- Heading is a clickable disclosure row; **collapsed by default** (PRD).
- When expanded, each row mirrors the My-documents row shape (title + description) but the right side replaces the thread-count badge with a muted **"X days left"** badge (red when ≤3 days), and adds a **[Restore]** action button.
- Row body does NOT navigate (the doc 404s for soft-deleted). Only the Restore button is interactive.
- Empty state when expanded: **"No deleted documents."**

### Routing

`apps/web/src/App.tsx` adds:

```tsx
{ path: '/d/:docId/v/:versionNumber', element: <DocumentPage /> }
```

`DocumentPage` reads `:docId` and optional `:versionNumber` via `useParams`:
- **No `versionNumber`** → use the existing `useDocument(docId)` hook; render latest. The version selector shows "v3 · latest".
- **`versionNumber` present** → call `useVersionsQuery(docId)` to resolve `versionNumber → versionId`. If not found, render a "Version not found" message with a back-link to `/d/:docId`.

`EditableField` for title PATCHes the document regardless of which version is viewed. Version-note edit is gated to the currently-viewed version.

## Validation rules

- **Document title:** 1–200 chars after trim. Empty → `400 invalid_body`.
- **Document description:** ≤2000 chars after trim; `null` allowed (clears).
- **Version note:** ≤500 chars after trim; `null` allowed (clears). Empty string normalized to `null` server-side.
- **Add-version file:** same rules as `POST /api/upload` — 10 MiB cap, `.html` extension, parseable as HTML.
- **Restore window:** `now() - deletedAt > 30 days` → `409 restore_window_expired`.

## Testing strategy

Same pattern as SP1–SP3: Vitest, real Postgres (`primer_test`), real filesystem temp dirs via `mkdtemp`, truncate-between-tests, file-serial. Frontend stays untested. The companion script is unchanged in SP4.

### Coverage

**`apps/api/src/routes/documents.test.ts` (MOD):**
- `GET /:docId` returns 404 for soft-deleted, even to the uploader.
- `PATCH /:docId` by uploader updates title; non-uploader → 403; soft-deleted → 404; empty body → 400; title >200 → 400.
- `PATCH` accepts `description: null` and clears.
- `DELETE /:docId` by uploader sets `deletedAt`; non-uploader → 403; idempotent on already-deleted.
- `POST /restore` clears `deletedAt`; idempotent on live doc; 409 when `deletedAt > 30 days ago` (forced via direct DB update).
- `POST /:docId/versions` happy path → 201 with `versionNumber = 2`. Two concurrent requests against the same doc → one 201, one 409 (verified by inspecting that exactly one new version exists).
- `POST /:docId/versions` rejected when doc is soft-deleted → 404.
- `GET /:docId/versions` returns the version list ordered by `versionNumber DESC`.
- View-tracking upsert (SP3) is skipped for soft-deleted-doc GETs.

**`apps/api/src/routes/versions.test.ts` (NEW):**
- `PATCH /api/versions/:vid` by uploader of the parent doc updates `versionNote`.
- Non-uploader → 403.
- `versionNote: null` clears.
- 404 when parent doc is soft-deleted.
- 400 when note >500 chars.

**`apps/api/src/routes/threads.test.ts` (MOD):**
- `POST /api/versions/:vid/threads` against a non-latest version → 409 `not_latest_version`.

**`apps/api/src/routes/dashboard.test.ts` (MOD):**
- `recentlyDeleted` returns only the requester's soft-deleted docs within 30 days, ordered by `deletedAt DESC`.
- Soft-deleted docs >30d old are excluded from `recentlyDeleted`.
- Restored docs disappear from `recentlyDeleted` and reappear in `myDocuments`.
- `daysRemaining` is computed correctly (a doc deleted 5 days ago → 25).

**`apps/api/src/jobs/purge.test.ts` (NEW):**
- No expired docs → empty report.
- One expired doc with one version → DB rows gone (verify by select), storage file deleted (verify `storage.get` rejects).
- Doc with multiple versions → all version files deleted.
- Storage `delete` failure for one version → key recorded in `failedStorageKeys`, doc row still deleted.
- Recently-deleted (within 30d) docs NOT purged.
- Idempotent — second run returns empty report.

## Exit criteria

SP4 is done when:

1. `pnpm install --frozen-lockfile && pnpm db:up && pnpm db:migrate && pnpm dev` boots cleanly. No new migrations; the purge interval kicks off in the background.
2. Upload a doc, view it, click **+ Version** from the header, drop a new HTML file with an optional note → modal closes, version selector shows v2 (latest), iframe renders the new content.
3. Use the version selector to switch back to v1 → URL becomes `/d/:docId/v/1`, read-mostly banner appears, "Add comment" / "Pick element" / composer all gone. Existing threads from v1 still show with full action affordances.
4. Click the title in the header (as uploader) → inline edit → save → header updates and home-page "My documents" row reflects the new title within the next dashboard refetch.
5. Edit description and version note via the same `EditableField`; empty/null clears them.
6. Delete the doc from the **⋯** menu → confirmation popover → home page's collapsed "Recently deleted" section expands to show it. Click **Restore** → doc reappears in My documents, viewable again at `/d/:docId`.
7. `curl -X POST /api/versions/:OLD_VID/threads` while two versions exist → `409 not_latest_version`.
8. Force `deletedAt` 31 days in the past via direct DB update, then attempt to restore via the API → `409 restore_window_expired`.
9. `pnpm db:purge` against a DB with an expired soft-deleted doc → doc gone, storage file gone, exit 0. Re-running → empty report, exit 0.
10. Boot dev with `PURGE_INTERVAL_MS=5000 pnpm dev`, seed an expired doc, wait ~5s, confirm the doc disappeared from the DB and storage (manual one-off; verifies the interval wiring).
11. `pnpm verify` is green: typecheck + tests + `pnpm audit --audit-level=high`.

## Deferred / out of scope (restated)

- Cross-version notifications (Slack DM when someone adds a new version of a doc you commented on) — sub-project 6.
- Version diff / "what changed" view — PRD non-goal.
- Comment reactions, emoji, rich text formatting — PRD non-goal.
- Page-level Recently-deleted route — could land in SP7 polish.
- Real Okta auth — sub-project 5. The uploader-only checks here use the mock-user middleware; the predicate stays the same when SP5 swaps the middleware.

## Open items the implementation plan should resolve

These don't change the design — they're details the plan will pin down with then-current information:

- Exact placement and copy of the `+ Add new version` link on the home page (sibling to `+ Upload document`? Under the My documents heading? The plan will decide).
- Whether `EditableField` shares a single textarea-vs-input branch in one component or splits into two (the plan will pick the cleaner shape — both are fine).
- Whether `VersionSelector` lives inside the `DocumentPage` header or as a sibling component (current intent: standalone component imported by `DocumentPage`).
- The exact strings for the read-mostly banner and the delete confirmation popover — plan can adjust copy as needed during implementation.
- The dropzone's drag-over background color — Tailwind class `bg-yellow-50` is a reasonable starting point; the plan adjusts if it clashes with existing yellow accents.
