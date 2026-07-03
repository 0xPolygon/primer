# Landing Page Overhaul — Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-07-03
**Status:** Draft
**Issue:** [#28](https://github.com/0xPolygon/primer/issues/28)

## Purpose

The current Primer landing page (`apps/web/src/routes/home.tsx`) is a lean 3-section list — *My documents*, *Recently viewed or commented*, *Recently deleted* — driven by `GET /api/dashboard`. There is no way to search, sort, filter, switch layout, or organize documents. Issue #28 asks for all of that plus a first-class notion of **folders** for personal organization.

This spec covers a full replacement of the landing page as a unified document library with search, sort, filter chips, a card/list layout toggle, and per-user folder labels. Two very small additions land on the document detail page as well: a back-to-folder link and a folder-assignment control. Every other Primer surface (versions, threads, comments, collaborators, admin, MCP, upload) is untouched.

## Non-goals

- **Shared or org-visible folders.** Folders in this spec are strictly per-user labels; they never affect who can see a document. If we ever want shared folders, that's a separate initiative with a different data model.
- **Nested folders.** Single flat level per user. Sub-folders are not in scope.
- **Bulk multi-select or drag & drop for folder assignment.** Kebab menu (⋯) is the only path in v1. Both are cheap follow-ups if a real need emerges.
- **Server-side search or a `q=` query parameter.** All search is client-side over the fetched list.
- **Full-text search over doc content or comment bodies.** Search matches title + description only. Content indexing is its own future ticket.
- **Pagination.** `/api/library` returns everything the caller can see in one response. Pagination becomes a ticket only if the response ever grows past what fits comfortably.
- **A "Most active" sort key.** The sort set is fixed at four (Recent activity, Recently uploaded, Title A→Z, Title Z→A).
- **Changes to non-landing surfaces except doc detail.** Only two additions on `document.tsx`: the `← Folder` back-link and the folder-assignment control.
- **Permission model changes.** Folders never gate access. Access remains `visibility + document_collaborators` as today.
- **Keeping `/api/dashboard`.** It's removed in the same PR. Home page is the only consumer; `/api/library` replaces it.

## Folder model

The heart of the feature is a specific choice about what folders *are*. We deliberately picked the simplest useful model:

- **Per-user labels, not per-document homes.** A folder belongs to one user. Assigning a doc to a folder only affects that user's view of the library. Teammates never see anyone else's folder structure. If Alice puts a doc in her "Research" folder, Bob (who can also read that doc) sees no folder assignment on it whatsoever. Bob may also have a "Research" folder — his and Alice's are completely independent.
- **Single level.** No nesting.
- **Single home per user.** In one user's view, each document lives in exactly one folder or in "Uncategorized". Not multiple folders. Not a tag / label semantic. Reassigning replaces.
- **Folders never affect access.** Access continues to be governed by `documents.visibility` plus `document_collaborators`. Filing an org doc in a private folder does not make it private, and unfiling never affects anyone else.

This model is the smallest change that delivers real organizational value without any of the coordination complexity of shared folder trees. Every design decision downstream derives from it.

## Data model

Two new tables. `documents` and every other existing table are untouched.

### `folders`

```
id          uuid primary key
user_id     text not null references users(id) on delete cascade
name        text not null
created_at  timestamptz not null default now()
updated_at  timestamptz not null default now()

unique (user_id, lower(name))
index  (user_id)
```

- Case-insensitive uniqueness per user, so `Research` and `research` cannot coexist.
- Names are trimmed on write. Empty / whitespace-only rejected. Max length 60 characters — a soft UI-driven limit chosen so long names never break the sidebar layout.
- Cascade on user delete.

### `document_folders`

```
user_id      text not null references users(id) on delete cascade
document_id  uuid not null references documents(id) on delete cascade
folder_id    uuid not null references folders(id) on delete cascade
created_at   timestamptz not null default now()

primary key (user_id, document_id)
index (folder_id)
```

- The primary key on `(user_id, document_id)` is what makes the single-home rule structural, not merely conventional. Reassignment is an UPSERT on that key. Unfiling is a DELETE.
- Cascades: deleting a folder drops its rows (docs revert to Uncategorized in that user's view — no toast, no confirmation prompt beyond the folder-delete confirm itself). Deleting a doc via hard delete cascades. **Soft-delete (`documents.deleted_at`) does not touch `document_folders`** — restoring a doc preserves everyone's folder assignments.
- "Uncategorized" is not a row. It is the absence of a `document_folders` row for that `(user_id, document_id)` pair.

### Migration

One new Drizzle migration adds both tables plus indexes. Uses UUIDs from `uuid_generate_v4()` matching the rest of the schema. No backfill needed — the world starts uncategorized.

## API surface

Five endpoints. `GET /api/dashboard` is removed in the same PR (nothing else calls it).

### `GET /api/library`

The one call the landing page needs. Returns library + folders + recently-deleted in one round trip so the sidebar and main pane render together.

```jsonc
{
  "folders": [
    { "id": "…", "name": "Research", "docCount": 12 }
  ],
  "documents": [
    {
      "id": "…",
      "title": "…",
      "description": "…" | null,
      "uploaderId": "…",
      "uploaderDisplayName": "…",
      "visibility": "org" | "private",
      "ownership": "mine" | "collaborator" | "org",
      "threadCount": 3,
      "activeThreadCount": 2,
      "lastActivityAt": "…",
      "createdAt": "…",
      "folderId": "…" | null
    }
  ],
  "recentlyDeleted": [
    { "id": "…", "title": "…", "deletedAt": "…", "daysRemaining": 27 }
  ]
}
```

- `documents` returns every doc the caller can read: `visibility='org'` OR `uploader_id = caller` OR caller is in `document_collaborators` for that doc.
- `ownership` is derived server-side per caller: `uploader_id === caller → 'mine'`; else in collaborators → `'collaborator'`; else `'org'`. This is what powers the *Mine / Shared with me / All* chip filter — chips are pure client-side predicates over this field.
- `folderId` reflects only the caller's assignment. Other users' assignments never leak.
- `folders[].docCount` counts the caller's assignments per folder. Uncategorized count is derived on the client (`documents.filter(d => d.folderId === null).length`).
- `recentlyDeleted` preserves current `dashboard.ts` semantics: caller's own soft-deleted docs in the last 30 days.

### `POST /api/folders`

Create. Body `{ name: string }`. Server trims the name before comparison and storage. Rejects empty / whitespace-only. Max 60 chars post-trim. `409` on case-insensitive duplicate against the caller's existing folders. Returns the folder DTO `{ id, name, docCount: 0 }`.

### `PATCH /api/folders/:folderId`

Rename. Body `{ name: string }`. Same trim/length/duplicate validation as `POST`. `404` if the folder does not belong to the caller. `409` on case-insensitive duplicate. Returns the updated folder DTO.

### `DELETE /api/folders/:folderId`

Delete. `404` if not caller-owned. Cascade drops `document_folders` rows. Returns `204`.

### `PUT /api/documents/:docId/folder`

Assign or unassign. Body `{ folderId: string | null }`. UPSERT on `(user_id, document_id)`. `folderId: null` unfiles. Requires the caller has read access to the doc (`visibility='org'` OR uploader OR collaborator). `403` if `folderId` refers to a folder that isn't the caller's.

### Cache invalidation

All four mutations (`POST/PATCH/DELETE /api/folders`, `PUT /api/documents/:docId/folder`) invalidate the react-query `['library']` key. Only `PUT /api/documents/:docId/folder` gets optimistic updates — it's the fastest, most repeated action.

## UI

### Route

Landing route stays `/`. Folder selection is URL-synced via a single query string parameter (`/?folder=<id>`) so back button and shared links work naturally. Every other lens (chip, sort, search) is ephemeral React state. Two things persist to `localStorage`:

- `primer.library.layout` — `"list"` | `"cards"`
- `primer.library.sort` — one of `"activity" | "uploaded" | "title-asc" | "title-desc"`

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Primer                              [+ Upload document]  │
├──────────────┬───────────────────────────────────────────┤
│              │ 🔍 [search…]                              │
│ Folders      │ [All] [Mine] [Shared with me] [Deleted]   │
│              │                          Sort ▾   ▤  ▦   │
│ All docs     ├───────────────────────────────────────────┤
│ Uncategor.   │                                            │
│ ───          │  <DocList or DocGrid>                     │
│ Research  12 │                                            │
│ Q3 planning 4│                                            │
│ Reading list │                                            │
│              │                                            │
│ + New folder │                                            │
└──────────────┴───────────────────────────────────────────┘
```

### Component tree

```
LibraryPage                     (rewrites routes/home.tsx)
├── LibraryHeader               (title + "+ Upload document")
├── LibrarySidebar
│   ├── SidebarItem  "All docs"
│   ├── SidebarItem  "Uncategorized"
│   ├── FolderRow × N           (name + count, hover-kebab → Rename / Delete)
│   └── NewFolderInput
├── LibraryToolbar
│   ├── SearchInput             (debounced 150ms, controlled)
│   ├── FilterChips             (All · Mine · Shared with me · Deleted)
│   ├── SortDropdown            (Recent activity / Recently uploaded / A→Z / Z→A)
│   └── LayoutToggle            (list ▤ / cards ▦)
└── LibraryBody
    ├── DocList → DocRow × N    (list mode; refactor of today's MyDocumentRow)
    └── DocGrid → DocCard × N   (cards mode; new)
    + DocKebabMenu              (shared: "Move to folder ▸")
```

### Data flow

`useLibraryQuery` hits `GET /api/library` and returns `{folders, documents, recentlyDeleted}`. All downstream state is a memoized derivation:

```
visibleDocs = documents
  .filter(d => matchesFolder(d, folderId))     // ignored when chip='deleted'
  .filter(d => matchesChip(d, chip))            // 'deleted' swaps source to recentlyDeleted[]
  .filter(d => matchesSearch(d, q))             // title + description substring, case-insensitive
  .sort(sortComparators[sortKey])
```

Sidebar counts (`folders[].docCount`, Uncategorized count, All count) reflect **folder totals only** — they do not respond to the current search/chip so the number doesn't jump around as you type.

### Filter chip semantics

| Chip | Predicate |
|---|---|
| **All** | `documents[]` unchanged |
| **Mine** | `d.ownership === 'mine'` |
| **Shared with me** | `d.ownership === 'org' \|\| d.ownership === 'collaborator'` |
| **Deleted** | **swaps source** to `recentlyDeleted[]`; folder highlight resets to "All docs"; sort + search still apply |

`Deleted` is deliberately different from the other chips: it's a state axis, not an ownership axis. Reusing today's `<DeletedDocumentRow>` avoids reinventing the restore button and days-remaining pill.

### Sort keys

- `Recent activity` (default) — descending by `lastActivityAt`. Same field the current dashboard already computes (max of doc creation, thread activity, comment activity).
- `Recently uploaded` — descending by `createdAt`.
- `Title A→Z` — locale-aware, case-insensitive.
- `Title Z→A` — inverse.

No sort direction toggle. Each option bakes its direction in.

### Layout toggle

- List: today's row. Refactored into a unified `DocRow` that reads `ownership` to render the correct subtitle ("just X" for `mine`, "by X · <signal>" for `org`/`collaborator`).
- Cards: 3-up grid at desktop, collapsing to 1 column below `sm`. Each card has a **decorative accent banner** at the top whose hue is deterministically derived from the doc `id` (a small `hash(id) → hue` function; fixed saturation/lightness in light and dark themes). Private docs render a dark banner with a `🔒 private` label overlaid. Below the banner: title, description (2-line clamp), footer with `by X · <relative time>` and thread status.

Toggle persists in localStorage.

### Kebab menu

Every `DocRow` and `DocCard` renders a `DocKebabMenu` in a corner (⋯). Menu items:

- `Move to folder ▸` → submenu listing the user's folders + "None (Uncategorized)" + "+ New folder…"
- (existing per-doc actions on doc detail like share, delete, etc. remain on doc detail — the kebab here is folder-focused for v1)

The "+ New folder…" branch pushes an inline `NewFolderInput` inside the menu, saves via `POST /api/folders`, then assigns the doc to it via `PUT /api/documents/:docId/folder`. Both mutations invalidate `['library']`.

### Doc detail additions

Two small additions to `apps/web/src/routes/document.tsx`, both above/near the existing title row:

1. **Back-to-folder link.** If the current user has this doc in one of their folders, render `← <Folder name>` above the title, linked to `/?folder=<id>`. Nothing renders if the doc is uncategorized in the user's view. This is a *back-to-my-folder* affordance, not a hierarchical breadcrumb — Primer folders are flat and per-user.

2. **Folder assignment control.** A small button in the doc-detail header next to the existing visibility/share/delete cluster: `Add to folder ▾` when uncategorized, `In: Research ▾` once assigned. Opens the same `FolderPickerMenu` used by the list kebab.

### Empty states

- **Zero docs library-wide** (new user): keep today's Diamond Age quote + "upload your first" CTA verbatim.
- **Folder is empty:** *"Nothing in **Research** yet. Move docs here from the ⋯ menu."*
- **No search results:** *"No docs matching &ldquo;onboarding&rdquo;."* with a `Clear search` link.
- **Chip filter produces empty result:** *"No documents match this view."* with a `Clear filters` link.
- **Deleted chip, empty:** *"No recently deleted documents."*

### Mobile / responsive

- Sidebar hidden below `md` (~768px). A `Folders ▾` button in the toolbar opens a bottom-sheet (using existing `BottomSheet` component) with the folder list, rename/delete via long-press → context menu, and the `+ New folder` action.
- Filter chips scroll horizontally rather than wrap, keeping toolbar height stable.
- Layout toggle remains visible; card grid collapses to 1 column below `sm` (~640px).
- Search input stretches to fill.

## Testing

Follow existing patterns — `apps/api/src/routes/*.test.ts` (Vitest, real Postgres per test) and `.snap.test.ts` on the web side.

### Backend

**`folders.test.ts`** — folder CRUD:
- `POST`: creates, trims, rejects empty/whitespace-only, rejects > 60 chars, 409 on case-insensitive duplicate for same user, allows same name across different users.
- `PATCH`: renames, 404 for non-owner, dedup enforced.
- `DELETE`: cascades `document_folders` rows, 404 for non-owner, other users' assignments unaffected.

**`documentFolder.test.ts`** — assignment:
- `PUT` assigns (INSERT), re-assigns (UPSERT overwrites), unassigns on `folderId: null`, 404 if caller can't read doc, 403 if folder isn't caller's, works on org docs by any reader, works on private docs by collaborator.

**`library.test.ts`** — the new endpoint:
- Returns docs the caller can read; excludes docs behind visibility they lack.
- `ownership` computed correctly per caller — the same doc reads `mine` for its uploader, `collaborator` for a granted user, `org` for a random reader.
- `folderId` reflects only caller's assignment; other users' assignments never leak.
- `folders[].docCount` accurate.
- `recentlyDeleted` still scoped to caller's own soft-deleted docs in last 30 days.

**Multi-user isolation** (in `library.test.ts` or dedicated):
- User A creates folder + assigns doc D. User B (who can read D) sees `folderId: null` on D.
- Both can hold folders named "Research" without collision.
- A deletes their folder → D becomes uncategorized in A's library, B untouched.

**Soft-delete round-trip** (in `documentFolder.test.ts`):
- Soft-delete a doc → assignment row persists. Restore doc → still assigned to the same folder for every user who had it filed.

### Frontend

- **Pure derivation function** in `apps/web/src/lib/library.ts`: `filterAndSort(documents, {folderId, chip, q, sortKey})`. Table-driven Vitest suite covering chip/filter/search intersection and every sort key. This is where the interesting client logic lives; keeping it pure makes it exhaustively testable.
- **Snapshot tests** for `DocRow` (mine/collab/org × org/private visibility) and `DocCard` (asserts banner hash is deterministic for a given id). Matches existing `BottomSheet.snap.test.ts` pattern.
- **Small render tests** for `LibraryToolbar` (chip active state, sort dropdown wiring, layout toggle persistence to localStorage) and `FolderPickerMenu` (folder list + "None" + "+ New folder" branch).

### Not tested

- No Playwright/E2E — the repo has no such harness; not adding one here.
- No visual regression on banner gradients — accept drift.
- No localStorage persistence assertions — trivial, not worth mocking.

### Manual verification

- Reviewer runs the new Drizzle migration against a staging snapshot via `pnpm db:migrate` and confirms both tables and indexes are created without touching existing data.

## Rollout

This is a single-PR change that removes `/api/dashboard` and rewrites `routes/home.tsx`. There is no feature flag and no gradual rollout — the endpoints, tables, and page all ship together. If we ship this and it turns out to be a regression, revert the PR; the migration is additive and safe to leave in place (empty tables cost nothing).

Decomposition into a stacked-PR series (schema → API → UI → doc-detail affordances) will be worked out in the writing-plans phase.
