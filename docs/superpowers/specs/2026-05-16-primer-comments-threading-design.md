# Sub-project 3 — Comments + threading + dashboard: Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-05-16
**Status:** Approved for implementation planning
**Parent PRD:** `docs/prd-primer.md`
**Parent decomposition:** `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
**Predecessors:**
- `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md` (sub-project 1, shipped)
- `docs/superpowers/specs/2026-05-13-primer-anchoring-companion-design.md` (sub-project 2, shipped)

## Purpose

Sub-project 3 takes the anchoring substrate from sub-project 2 and wires it to real comment threads in the database, ships the comment sidebar UI on the document viewer, and replaces the home-page placeholder with a real dashboard ("My documents" + "Recently viewed or commented"). At the end, two browser tabs as the same mock user can carry on a threaded conversation on any uploaded artifact: drop a comment, reply, resolve, reopen-via-reply, edit, delete-as-tombstone.

The ephemeral "Add comment" affordance and in-memory anchor list from sub-project 2 are *replaced* by their real, DB-backed counterparts here. Notifications are wired through a `Notifier` interface but resolve to a no-op stub — sub-project 6 swaps in real Slack dispatch behind the same interface.

## Scope summary

**In scope:**

- New `document_views` table (composite PK `(user_id, document_id)`) for "Recently viewed" tracking.
- TypeScript refinement of `threads.anchor` to the typed `AnchorData` union from `@primer/shared/companion-protocol`.
- Eight REST endpoints (six CRUD on threads/comments, one polling target with `If-None-Match`/`304`, one dashboard aggregation).
- `Notifier` interface with `NoopNotifier` default implementation; injected via `AppDeps`.
- `CommentSidebar` React component (360px expanded, 36px collapsed rail), with `ThreadCard`, `NewThreadComposer`, "Hide resolved" filter, document-order sort once anchor positions return.
- Polling via TanStack Query at 10s, foreground-only (pause on `document.hidden`, force refetch on regain), conditional via ETag.
- Floating "Add comment" pill → sidebar composer (replaces the SP2 proto auto-save).
- Pick-mode → sidebar composer (replaces the SP2 proto auto-save for element-pick too).
- Drifted-anchor indicator in the sidebar ("📍?" badge + dimmed row).
- View-tracking upsert as a side-effect of `GET /api/documents/:docId`.
- Real dashboard on `HomePage`: two stacked sections, list-style rows, click-to-navigate.

**Out of scope (deferred to later sub-projects):**

- Iframe-to-sidebar focus on highlight click (sub-project 7 polish).
- Versioning UI (`/d/:docId/v/:versionNumber`), add-new-version flow, multi-version threads (sub-project 4).
- Soft-delete UI for documents, "Recently deleted" section, 30-day restore window, metadata editing (sub-project 4).
- @mention parsing + typeahead, Slack DM dispatch, Okta-to-Slack ID resolution, deep-link payloads (sub-project 6).
- Real Okta auth, CSRF, multi-user authorization tests against real sessions (sub-project 5).
- Production deploy / observability.

## Stack notes

No new runtime dependencies. Reuse:
- `drizzle-orm` for the new `document_views` table.
- TanStack Query (already in `apps/web`) for polling + cache.
- Hono + postgres.js + parse5 — existing stack.

`@primer/shared` gains a few DTOs and re-exports of two type guards from `companion-protocol` (`isTextRangeAnchor`, `isElementPathAnchor`) so the API can validate anchor JSON without duplicating logic.

## File map

```
packages/shared/src/
  schema.ts                    # MOD — add documentViews table; refine threads.anchor type
  api.ts                       # MOD — add Thread/Comment/Dashboard DTOs
  companion-protocol.ts        # MOD — export isTextRangeAnchor + isElementPathAnchor helpers

apps/api/src/
  routes/threads.ts            # NEW
  routes/threads.test.ts       # NEW
  routes/comments.ts           # NEW
  routes/comments.test.ts      # NEW
  routes/dashboard.ts          # NEW
  routes/dashboard.test.ts     # NEW
  routes/documents.ts          # MOD — upsert document_views on GET
  routes/documents.test.ts     # MOD — assert view upsert
  notifications/notifier.ts    # NEW — Notifier interface + NoopNotifier
  notifications/notifier.test.ts # NEW — basic NoopNotifier invocation test
  app.ts                       # MOD — register new routes; inject notifier into deps
  index.ts                     # MOD — instantiate NoopNotifier
  drizzle/000X_document_views.sql  # NEW — generated migration

apps/web/src/
  components/
    CommentSidebar.tsx         # NEW
    ThreadCard.tsx             # NEW
    NewThreadComposer.tsx      # NEW
    DocumentListRow.tsx        # NEW (used by HomePage)
  queries/
    threads.ts                 # NEW — useThreadsQuery (polled, conditional)
    dashboard.ts               # NEW — useDashboardQuery
    mutations.ts               # NEW — useCreateThread, useReply, useResolveThread,
                               #        useReopenThread, useEditComment, useDeleteComment
  routes/
    document.tsx               # MOD — drop SP2 ephemeral state; mount sidebar
    home.tsx                   # MOD — replace placeholder with real lists
```

## Architecture overview

```
┌──────────────────── apps/web ─────────────────────────────────────┐
│                                                                    │
│  HomePage                                                          │
│    └─ useDashboardQuery → GET /api/dashboard                       │
│       Renders: My documents (uploads by user)                      │
│                Recently viewed or commented (last 30 days)         │
│                                                                    │
│  DocumentPage                                                      │
│    ├─ <ArtifactIframe …>           (from SP2; unchanged)           │
│    ├─ <CommentSidebar …>           (NEW)                           │
│    │   ├─ useThreadsQuery          (polled 10s, conditional via    │
│    │   │                            ETag, paused on tab blur)      │
│    │   ├─ <NewThreadComposer />    (shown while pendingSelection   │
│    │   │                            or pendingPick exists)         │
│    │   └─ <ThreadCard /> × N       (sorted by anchor doc position) │
│    └─ <AddCommentPill /> (SP2)     (click → opens composer)        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                          REST + ETag
                              │
┌──────────────────── apps/api ─────────────────────────────────────┐
│                                                                    │
│  routes/                                                           │
│    threads.ts        GET  /api/versions/:vid/threads               │
│                      POST /api/versions/:vid/threads               │
│                      POST /api/threads/:tid/resolve                │
│                      POST /api/threads/:tid/reopen                 │
│    comments.ts       POST /api/threads/:tid/comments               │
│                      PATCH /api/comments/:cid                      │
│                      DELETE /api/comments/:cid                     │
│    documents.ts      GET /api/documents/:docId  (+view upsert)     │
│    dashboard.ts      GET /api/dashboard                            │
│                                                                    │
│  notifications/                                                    │
│    Notifier (interface) — notifyMentions, notifyReplyParticipants  │
│    NoopNotifier — logs at debug, returns void                      │
│    [SlackNotifier replaces in SP6 behind same interface]           │
│                                                                    │
│  Drizzle:                                                          │
│    document_views (user_id, document_id, viewed_at) — new          │
│    threads, comments — existing; first real use                    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Data model

### New table: `document_views`

```ts
// packages/shared/src/schema.ts (append)
import { primaryKey } from 'drizzle-orm/pg-core';

export const documentViews = pgTable(
  'document_views',
  {
    userId: text('user_id').notNull().references(() => users.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
  })
);
```

Composite primary key on `(user_id, document_id)`. Upsert on every `GET /api/documents/:docId` — one row per (user, doc), `viewed_at` monotonically advances. Cascade on document delete keeps the table tight.

### TypeScript refinement on `threads.anchor`

The `threads` row from SP1 has `anchor: jsonb('anchor').notNull()` — untyped JSON. Refine to:

```ts
import type { AnchorData } from './companion-protocol.ts';

export const threads = pgTable('threads', {
  // … other fields unchanged …
  anchor: jsonb('anchor').$type<AnchorData>().notNull(),
  // …
});
```

TypeScript-only change; no SQL migration needed. The wire `Anchor { id, data: AnchorData }` projects naturally: `id = threads.id`, `data = threads.anchor`.

### `comments.mentions` in sub-project 3

Stays `text[] not null default '{}'`. Always written as `[]` from comment-create and comment-edit paths. Sub-project 6 will populate it via mention-parsing.

### Migration

One new SQL migration generated by `drizzle-kit generate` after the schema edit: creates `document_views` with the composite PK and FK constraints. No other schema deltas.

## API surface

All endpoints behind `mockUserMiddleware`; `c.get('user').id` is the active user identifier. Error responses follow the SP1 shape: `{ error: '<code>', message: string }`.

### `GET /api/versions/:versionId/threads`

Polling target. Returns the full thread list for a version, with comments inlined.

**Request headers:**
- `If-None-Match` (optional) — last ETag the client saw.

**ETag computation (one query):**

```sql
SELECT
  COALESCE(GREATEST(
    MAX(t.created_at), MAX(t.resolved_at),
    MAX(c.created_at), MAX(c.updated_at), MAX(c.deleted_at)
  ), 'epoch'::timestamptz) AS max_ts,
  COUNT(DISTINCT t.id) AS thread_count,
  COUNT(c.id) AS comment_count
FROM threads t
LEFT JOIN comments c ON c.thread_id = t.id
WHERE t.version_id = $1;
```

`ETag = "W/\"" + sha256(max_ts.toISOString() + '|' + thread_count + '|' + comment_count).slice(0,16) + "\""`. Weak ETag (`W/`) — the spec doesn't care about byte-equality, only "anything changed in this version's threads/comments".

**Response:**
- `304 Not Modified` if `If-None-Match` matches the computed ETag. Empty body. Returns the ETag header so the client can keep using it.
- `200 OK` with `Content-Type: application/json` and the body:

  ```json
  {
    "threads": [ThreadDTO, …],
    "asOf": "2026-05-16T18:42:11.000Z"
  }
  ```

  Threads sorted by `created_at asc`; the client re-sorts by document position once the companion returns `anchor_positions`. Resolved threads are always included; the "Hide resolved" filter is client-side (avoids two separate ETags).

### `POST /api/versions/:versionId/threads`

Creates a new thread anchored to this version.

**Request body:**

```ts
{
  anchor: AnchorData;  // text-range OR element-path
  body: string;        // 1–5000 chars after trim
}
```

**Validation:**
- `anchor` matches `isTextRangeAnchor` OR `isElementPathAnchor` (helpers from `companion-protocol`); otherwise `400 invalid_anchor`.
- `body` trimmed: 1–5000 chars; otherwise `400 invalid_body`.

**Behavior:**
Single transaction: insert `threads` row with `anchor`, then insert first `comments` row with `body`, `author_id = c.get('user').id`, `mentions = []`. Both UUIDs are `uuidv7()`. Calls `notifier.notifyMentions({ mentions: [], threadId, commentId, actorUserId })` after commit (no-op in SP3).

**Response:** `201 Created` with the full `ThreadDTO` (including the first comment).

### `POST /api/threads/:threadId/comments`

Reply to an existing thread.

**Request body:** `{ body: string }` — same validation as thread create.

**Behavior:**
Single transaction:
1. Insert reply `comments` row.
2. **If the thread's `resolved_at IS NOT NULL`, also UPDATE the thread to set `resolved_at = NULL, resolved_by = NULL`** — auto-reopen on reply, per PRD.
3. After commit: gather all prior comment authors on this thread except the actor, call `notifier.notifyReplyParticipants(...)`. Also calls `notifyMentions([], ...)` for the new comment.

**Response:** `201 Created` with `{ comment: CommentDTO, thread: ThreadDTO }` — the thread payload reflects the (possibly-reopened) state.

### `POST /api/threads/:threadId/resolve`

Sets `resolved_at = now(), resolved_by = c.get('user').id`. Returns `200` with the updated `ThreadDTO`. No notification.

If the thread is already resolved (`resolved_at IS NOT NULL`), the resolve is idempotent — re-stamps `resolved_at` and `resolved_by`. PRD doesn't prohibit; we accept.

### `POST /api/threads/:threadId/reopen`

Manual reopen. Sets `resolved_at = NULL, resolved_by = NULL`. Returns `200` with the updated `ThreadDTO`. No notification. Idempotent.

### `PATCH /api/comments/:commentId`

Edits a comment body.

**Authorization:** the comment's `author_id` must equal `c.get('user').id`; otherwise `403 forbidden`.

**Validation:** the comment must not be soft-deleted (`deleted_at IS NULL`); otherwise `409 conflict`. Body 1–5000 chars after trim.

**Behavior:** sets `body = $body, updated_at = now()`. Calls `notifier.notifyMentions({ mentions: [], ... })` after commit (SP3 always passes `[]`; SP6 will compute newly-added mentions).

**Response:** `200 OK` with the updated `CommentDTO`.

### `DELETE /api/comments/:commentId`

Soft-delete (tombstone).

**Authorization:** author-only, `403` otherwise. Idempotent — deleting an already-deleted comment returns 200 with the existing tombstone.

**Behavior:** sets `deleted_at = now()`. The row is preserved so reply context isn't broken; the response (and all subsequent `GET /threads` responses) blanks `body` to `''`.

**Response:** `200 OK` with the tombstoned `CommentDTO` (`body: ''`, `deletedAt` populated).

### `GET /api/dashboard`

Aggregation endpoint for the home page.

**Response:**

```ts
interface DashboardResponse {
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
}
```

**`myDocuments`:** all `documents` where `uploader_id = user.id AND deleted_at IS NULL`. For each, compute:
- `threadCount` = count of threads across all versions of the doc.
- `activeThreadCount` = count with `resolved_at IS NULL`.
- `lastActivityAt` = max of (`documents.created_at`, max thread `created_at`/`resolved_at`, max comment `created_at`/`updated_at`/`deleted_at`).

Ordered by `lastActivityAt` desc. No cap (PRD: uncapped).

**`recentlyViewedOrCommented`:** union of (a) `document_views` for the user where `viewed_at > now() - interval '30 days'`, and (b) docs where the user authored a comment in the last 30 days (derived via `comments → threads → versions → documents` join). For each doc, take the most recent of the two signals, attach `signal: 'viewed' | 'commented'` and `signalAt`. Ordered by `signalAt` desc. **Uncapped** per the PRD — the 30-day window naturally bounds total rows for a Polygon-sized cohort.

Both lists exclude docs whose `documents.deleted_at IS NOT NULL` (sub-project 4 will add soft-deleted-doc UI; until then they should be invisible).

### DTOs (in `@primer/shared/api`)

```ts
import type { AnchorData } from './companion-protocol.ts';

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;             // empty string when deletedAt is set (tombstone)
  createdAt: string;        // ISO
  updatedAt: string | null;
  deletedAt: string | null;
  mentions: string[];       // always [] in SP3
}

export interface ThreadDTO {
  id: string;
  versionId: string;
  anchor: AnchorData;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: string;
  comments: CommentDTO[];
}

export interface ThreadsListResponse {
  threads: ThreadDTO[];
  asOf: string;
}

export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
}

export interface CommentBodyRequest {
  body: string;
}

export interface DashboardDocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
}

export interface DashboardActivityEntry extends DashboardDocumentSummary {
  signal: 'viewed' | 'commented';
  signalAt: string;
}

export interface DashboardResponse {
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
}
```

## Polling client behavior

### Hook

`apps/web/src/queries/threads.ts` exports `useThreadsQuery(versionId)` using TanStack Query.

```ts
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ThreadsListResponse } from '@primer/shared';

export function useThreadsQuery(versionId: string) {
  const [paused, setPaused] = useState(document.hidden);
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // queryFn keeps the last ETag in module-scope state keyed by versionId
  // so re-renders don't lose it. Returns the parsed body on 200 or a sentinel
  // on 304. TanStack Query 5 supports `placeholderData: keepPreviousData`
  // so the cached body is preserved through 304s.
  return useQuery({
    queryKey: ['threads', versionId],
    queryFn: async ({ signal }) => fetchThreadsConditional(versionId, signal),
    refetchInterval: paused ? false : 10_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    staleTime: 0,
    retry: 1,
  });
}
```

`fetchThreadsConditional`:

1. Read the cached ETag for this `versionId` from a module-level `Map<string, string>`.
2. `fetch('/api/versions/:vid/threads', { headers: { 'If-None-Match': cachedEtag } })`.
3. If `res.status === 304`, return the existing cached `ThreadsListResponse` (via TanStack's previous-data placeholder). The hook handles this — the implementation plan picks the exact recipe (e.g., throw a `NotModifiedError` and configure `retry` + `placeholderData`).
4. Else read the new ETag from the response header, stash it, return the parsed body.

**Mutations** (in `apps/web/src/queries/mutations.ts`): each mutation hits its endpoint, on success calls `queryClient.invalidateQueries(['threads', versionId])` to force the next poll to use the new ETag and reconcile. Optimistic updates allowed for fast UX (insert "saving…" placeholder, replace on response, rollback on error).

### Anchor-position re-sort

Threads arrive sorted by `created_at`. The sidebar pushes `update_anchors` to the iframe, then requests `request_anchor_positions`. When the response arrives, threads with known positions sort by `rects[0].y` ascending; threads marked `drifted` cluster at the bottom under a "Could not place" header.

The same re-sort triggers on every fresh `anchor_positions` response (e.g., after `resize` triggers the parent to re-request).

## Sidebar UI

### Expanded (360px)

- **Header (40px tall):** `{n} thread{s}` count on the left; `[☐ Hide resolved]` toggle + `›` collapse button on the right.
- **Composer slot:** when `pendingSelection` or `pendingPick` is set, render `NewThreadComposer` at the top (yellow strip) with the anchor preview, textarea (autofocused), and `Cancel`/`Comment` buttons. Submit posts the new thread.
- **Threads list:** compact rows (see SP3 sidebar mockup):
  - Anchor preview (italic, yellow left rule, truncated to ~60 chars for text-range; full path chip for element-path).
  - Top-level comment: author name, relative time, body.
  - Replies: indented under the parent, separated by dashed rule.
  - Inline action links: `Reply · Resolve|Reopen · Edit · ⋮` (Edit only if user is author; `⋮` opens menu with Delete and a deep link, both author-gated). Tombstoned comments render `*deleted by author*` instead of body; their action links are absent.
- **Drifted thread:** rendered with a "📍?" badge next to the anchor preview, dimmed slightly, sorted at the bottom under "Could not place".
- **Resolved thread:** opacity reduced; "RESOLVED" indicator inline; action set swaps "Resolve" for "Reopen".

### Collapsed (36px rail)

- Top: `›` (expand) button.
- Below: count pill showing total active thread count.
- Vertical thread markers — small yellow blocks at the y-position of each anchor (gray for resolved). Click any marker → expand + scroll iframe to that anchor.

Collapse state persists in `localStorage` keyed `primer.sidebar.collapsed`.

### Composer triggers

**Text selection path** (already mostly wired in SP2):
1. `selection_captured` from the iframe → parent sets `pendingSelection`.
2. SP2's black "Add comment" pill renders near the selection rect.
3. User clicks the pill → pill dismisses, sidebar opens `NewThreadComposer` with the selection's preview. Textarea autofocuses.
4. Submit → `useCreateThread` mutation → optimistic insert into the threads list → success replaces the placeholder; failure rolls back and surfaces the error inline in the composer.
5. Cancel or arrival of a new selection clears the composer state.

**Element-pick path:**
1. User toggles pick mode via the existing header button (SP2).
2. `element_picked` → parent sets `pendingPick` (parallel to `pendingSelection`).
3. Same `NewThreadComposer` shows in the sidebar, preview rendered as a path chip.
4. Submit → `useCreateThread` with the `ElementPathAnchor`.

**Important:** the SP2 proto auto-saved on `element_picked` (`queueMicrotask(... update_anchors)`). SP3 removes that block — element pick must go through the composer just like text selection.

### Reply / edit composers

`ThreadCard` renders inline mini-composers when the user clicks `Reply` or `Edit`. Both share the same textarea component as the new-thread composer but submit different mutations.

## View tracking

`GET /api/documents/:docId` (existing SP1 endpoint) gains a fire-and-forget side effect at the end of its handler:

```ts
await db.execute(sql`
  INSERT INTO document_views (user_id, document_id)
  VALUES (${user.id}, ${docId})
  ON CONFLICT (user_id, document_id) DO UPDATE SET viewed_at = excluded.viewed_at
`);
```

Wrapped in a try/catch that logs a `warn` and otherwise swallows. The doc response returns 200 regardless. The dashboard is the only consumer of `document_views`; a single missed view is invisible to anything else.

## Dashboard wiring

`HomePage` (`apps/web/src/routes/home.tsx`) is replaced. New shape:

- `useDashboardQuery()` hits `GET /api/dashboard`. Default TanStack Query cache; refetch on window focus. No polling — dashboard is low-traffic.
- Two `<section>`s matching the approved mockup:
  - **My documents** — `myDocuments` rows; empty state: "No documents yet. Upload your first one."
  - **Recently viewed or commented** — `recentlyViewedOrCommented` rows; subtitle includes uploader + the active signal ("you commented 1h ago" vs "viewed yesterday"). Empty state: "Nothing recent."
- Each row click navigates to `/d/:docId`.
- Page top retains the "Upload a new document" CTA from SP1.

## Notifier interface

```ts
// apps/api/src/notifications/notifier.ts
import { logger } from '../logger.ts';

export interface Notifier {
  notifyMentions(args: {
    mentions: string[];
    threadId: string;
    commentId: string;
    actorUserId: string;
  }): Promise<void>;

  notifyReplyParticipants(args: {
    participantUserIds: string[];
    threadId: string;
    commentId: string;
    actorUserId: string;
  }): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyMentions(args: Parameters<Notifier['notifyMentions']>[0]) {
    logger.debug({ args }, 'notifyMentions (no-op)');
  }
  async notifyReplyParticipants(args: Parameters<Notifier['notifyReplyParticipants']>[0]) {
    logger.debug({ args }, 'notifyReplyParticipants (no-op)');
  }
}
```

`createApp` extends `AppDeps` to `{ storage: Storage; notifier: Notifier }`. `apps/api/src/index.ts` instantiates `new NoopNotifier()`. SP6 replaces with `SlackNotifier` — same interface, no call-site changes anywhere.

## Validation rules

- **Comment body:** 1–5000 chars after `.trim()`. Empty / too long → `400 invalid_body`.
- **Anchor on create:** validated by `isTextRangeAnchor(raw) || isElementPathAnchor(raw)` exported from `companion-protocol`. Otherwise `400 invalid_anchor`.
- **Path params:** UUID v7 format check for `:versionId`, `:threadId`, `:commentId`, `:docId`. Malformed → `400 invalid_id`.
- **Author-only mutations:** `403 forbidden` when `comment.author_id !== user.id`.
- **Operating on tombstoned comments:** `409 conflict` for `PATCH` and `200 idempotent` for `DELETE`.

## Testing strategy

Following SP1/SP2: Vitest, real Postgres against `primer_test`, file-serial, truncate-between-tests. Frontend tests still skipped (sub-project 7 polish window).

### New test files

- `apps/api/src/routes/threads.test.ts`:
  - `POST` creates a thread + first comment in one tx; response shape matches DTO; row counts incremented.
  - `POST` rejects empty body / >5000 chars / invalid anchor.
  - `GET` returns 200 + ETag on first call.
  - `GET` returns 304 when `If-None-Match` matches.
  - `GET` returns new 200 + new ETag after any mutation that changes thread state.
  - `POST /:tid/resolve` sets fields; idempotent.
  - `POST /:tid/reopen` clears fields; idempotent.
  - **`POST /:tid/comments` on a resolved thread auto-reopens and includes the (cleared) resolution in the response thread.**

- `apps/api/src/routes/comments.test.ts`:
  - `PATCH` by author succeeds; body updated; `updatedAt` set.
  - `PATCH` by non-author returns 403.
  - `PATCH` on tombstoned comment returns 409.
  - `DELETE` by author returns 200 + tombstone (`body: ''`, `deletedAt` set, row preserved).
  - `DELETE` by non-author returns 403.
  - `DELETE` idempotent for already-tombstoned.

- `apps/api/src/routes/dashboard.test.ts`:
  - Empty user → both lists empty.
  - User with uploads → `myDocuments` ordered by activity.
  - User who commented on another user's doc → entry in `recentlyViewedOrCommented` with `signal: 'commented'`.
  - User who viewed another user's doc → entry with `signal: 'viewed'`.
  - View + comment on same doc → single entry with the more recent signal.

- `apps/api/src/routes/documents.test.ts` (extend existing):
  - `GET /api/documents/:docId` triggers `document_views` upsert.
  - Second `GET` updates `viewed_at` without duplicating the row.

### Integration tests for the notifier

- `apps/api/src/notifications/notifier.test.ts`: instantiate `NoopNotifier`, call both methods, confirm they resolve without throwing. Verifying invocation from create-thread / reply paths is covered by the threads/comments suites (asserting on the deps spy).

## Exit criteria

Sub-project 3 is **done** when all of these hold:

1. `pnpm install --frozen-lockfile && pnpm db:up && pnpm db:migrate && pnpm dev` boots cleanly from a fresh clone (including the new `document_views` migration).
2. From the home page after upload, the document appears under "My documents" with thread count 0 and timestamp "now".
3. On the document viewer, select text → "Add comment" pill → click → sidebar composer opens → submit → highlight appears in iframe and thread appears in sidebar.
4. Enter pick mode → click an element → composer opens with the path chip as the anchor preview → submit → 💬 badge appears in iframe and element-path thread appears in sidebar.
5. Click "Reply" on a thread → reply composer inline → submit → reply nests under the parent comment.
6. Click "Resolve" on a thread → thread grays out. Toggle "Hide resolved" → it disappears from the list. Toggle off → reappears.
7. Resolve a thread, then click "Reply" on it. The thread auto-reopens (no longer gray, no RESOLVED badge) and the new reply is appended.
8. Edit own comment → after submit, comment shows new body + a small "(edited)" indicator.
9. Delete own comment → comment shows "deleted by author" in muted text; thread and other comments are unchanged.
10. Open two tabs of `/d/<docId>`. Tab A submits a comment. Tab B's sidebar shows the new comment within ~10s. Network tab shows `304` responses on most polls.
11. `curl -X PATCH /api/comments/:cid` for a comment owned by a different user returns `403` (verified via integration test since the browser has one mock user).
12. Click a thread card in the sidebar → iframe scrolls the anchor into view and the highlight pulses for ~1.5s.
13. Drifted anchor: viewing a doc whose only thread's `selectorText` is no longer in the live HTML, the thread shows in the sidebar under "Could not place" with a "📍?" indicator and no in-iframe marker.
14. Collapsed rail: clicking the `›` button on the sidebar header collapses to 36px showing markers; clicking a marker expands + scrolls.
15. `pnpm verify` is green (typecheck + tests + audit).

## Deferred / out of scope (restated)

- Iframe-to-sidebar focus on highlight click (sub-project 7 polish).
- Versioning UI, add-new-version flow, soft-delete UI for documents, recently-deleted section, 30-day restore, metadata editing (sub-project 4).
- @mention parsing + typeahead, Slack DM dispatch, Okta-to-Slack ID resolution, deep-link payloads (sub-project 6).
- Real Okta auth, CSRF, multi-user authorization tests against real sessions (sub-project 5).
- Production deploy, observability, rate-limiting.

## Open items the implementation plan should resolve

These are detail-level decisions the plan should make using current information; they don't change the design:

- The exact TanStack Query 5 idiom for returning "unchanged" from `queryFn` while preserving cached data. Recipe candidates: `placeholderData: (prev) => prev` + throwing `NotModifiedError` + `retry: false`, or returning the previous payload directly. Pick one and document.
- Whether `useThreadsQuery` keeps the ETag in a module-level `Map<versionId, etag>` or hangs it off `queryClient.getQueryData(['threads', versionId])` metadata. Either works; pick one for consistency.
- Whether `NewThreadComposer` uses a controlled `<textarea>` with manual key handling for Cmd/Ctrl+Enter to submit, or relies on an explicit Comment button. Recommend: both. Cmd/Ctrl+Enter is a power-user nicety.
- Exact dependency between TanStack Query mutations and optimistic UI rollback — pick whether to `onMutate`-snapshot the cache or refetch on rollback. `onMutate` snapshot is the standard pattern.
