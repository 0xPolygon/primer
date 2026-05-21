# Hide Deleted Comments — Design

**Date:** 2026-05-21
**Status:** Approved

## Goal

Tombstoned comments (where `deletedAt !== null`) should not appear in the comment sidebar at all. Today they render as a placeholder line "deleted by author"; that line goes away. Threads whose every comment is deleted should also disappear from the sidebar. Threads where the original (first) comment is deleted but replies survive should still be visible, with the first surviving reply taking the visible "root" position.

## Non-goals

- No API/server changes. The threads endpoint continues to return tombstoned comments with empty body + `deletedAt` set. Filtering happens client-side.
- No change to home-page activity counts ("X/Y active" pills). Those come from server-side aggregates and don't justify a back-end change for cosmetic consistency.
- No change to the comments markdown export — it already excludes tombstoned comments (precedent for client-side filtering).
- No tombstone history UI ("show deleted comments" toggle).
- No change to mention / notification logic, sticky focus, or the iframe companion overlay.

## Architecture

```
useThreadsQuery (unchanged)
        │
        ▼
threads[] with tombstoned comments included
        │
        ▼
   CommentSidebar
        │
        ├─ filter: keep only threads with ≥1 non-tombstoned comment
        ├─ recompute "N thread(s)" header from filtered list
        └─ render <ThreadCard> for each surviving thread
                 │
                 ▼
            ThreadCard
                 │
                 ├─ filter comments: keep only non-tombstoned
                 ├─ destructure [first, ...replies] = survivors
                 └─ render comments as before (no tombstone branch)
```

Two changes, both client-only:

1. **`apps/web/src/components/ThreadCard.tsx`** — derive `survivingComments` from `thread.comments` by dropping tombstones, then destructure `[first, ...replies] = survivingComments`. Drop the `isTombstoned` branch in `CommentRow` entirely (the row is never rendered for a tombstoned comment now). Also drop the related `isTombstoned`-conditional UI: the "(edited)" italic was hidden during tombstone state and the "deleted by author" italic block — neither remains.
2. **`apps/web/src/components/CommentSidebar.tsx`** — derive `visibleThreads` from the existing `sortedThreads` by dropping threads whose every comment is tombstoned. Use `visibleThreads.length` for the header thread count, and for the "X thread(s)" badge in the collapsed state. The `activeCount` (open vs resolved) is also recomputed from the visible list.

## Behavior details

- **Thread with all replies deleted but root surviving.** First (root) renders normally; replies section is empty. Identical to a fresh thread.
- **Thread with root deleted, replies surviving.** First surviving reply becomes the visible root. It loses its left-margin / dashed-divider "reply" treatment because it's at position 0. The thread `anchor` and `id` are unchanged.
- **Thread with every comment deleted.** Thread doesn't appear in the sidebar. The anchor in the artifact iframe is also not painted (anchors are derived from `anchorsForCompanion` which already maps from threads — so we need to filter that too; see below).
- **Resolving/unresolving an empty-of-comments thread.** Not possible from the UI because the thread isn't rendered. Existing API endpoints still work, so admin-y workflows remain available.
- **Replying to a thread whose root is deleted.** Works — the thread.id is still valid, the API doesn't care about the visible-root concept.

## Anchor painting

`DocumentPage` computes `anchorsForCompanion` as `threads.map((t) => ({ id: t.id, data: t.anchor }))`. This currently includes threads with all-tombstoned comments — their anchors would still paint highlights in the iframe with no clickable card behind them. To stay consistent, also filter at this level:

```ts
const anchorsForCompanion = useMemo(
  () => threads
    .filter((t) => t.comments.some((c) => c.deletedAt === null))
    .map((t) => ({ id: t.id, data: t.anchor })),
  [threads]
);
```

That filter applied here keeps the companion's highlight set in sync with what the sidebar shows.

## Files touched

- `apps/web/src/components/ThreadCard.tsx` — derive `survivingComments`; drop tombstone branch in `CommentRow`.
- `apps/web/src/components/CommentSidebar.tsx` — derive `visibleThreads`; use it for header count, collapsed-state thread list, and badge.
- `apps/web/src/routes/document.tsx` — add the `.filter(...)` to `anchorsForCompanion`.
- `apps/web/src/components/ThreadCard.test.ts(x)` — new file, small Vitest that asserts tombstoned comments don't render and threads with all-tombstoned comments are filtered upstream. (Alternative: add tests next to `exportComments.test.ts` since that's the closest analog already in-tree.)

## Edge cases

- `thread.comments` is empty (shouldn't happen — every thread has ≥1 comment by API contract, since creating a thread inserts a comment in the same transaction). If it ever does, filtering produces an empty array, and the thread is correctly dropped by `CommentSidebar`.
- `thread.comments` has a single comment which is then deleted: covered — `visibleThreads` filter drops the thread.
- Mid-session deletion: a user deletes their only comment in a thread. The optimistic mutation updates the local cache; on next render, `visibleThreads` drops the thread. The user's experience: the thread card vanishes immediately. Same UX as an admin deleting a document — clean, no transition.

## Testing

- Unit test for `ThreadCard` (or its filtering helper if extracted): given a thread with a mix of tombstoned and surviving comments, only surviving ones render; tombstoned never appear; "(edited)" still renders for surviving edits.
- Unit test for the thread-filtering helper in `CommentSidebar`: given a list of threads with various tombstone patterns, threads with no surviving comments are dropped.
- Manual: kick off `pnpm dev`, open a doc, add a comment, delete it → thread vanishes from sidebar AND highlight vanishes from iframe. Add another comment + delete the original root → reply takes visible-root position.

## Risks

- **Home-page "X/Y active" pill drifts** when a thread's last comment is deleted. The pill still counts that thread as "active." Acceptable for now — it's a server-side aggregate and the visual cost of fixing it (adding a `where exists (select 1 from comments c where c.thread_id = t.id and c.deleted_at is null)` predicate to the dashboard query) is more than the value of the fix. If it gets reported as a bug we can address it then.
- **Etag stability.** The threads endpoint etag includes deleted-comment timestamps, so deletion still busts the cache and the client re-fetches. No regression.
- **Notifier behavior.** Mentions and "you commented" notifications fire at comment-create time and don't observe deletion state, so unaffected.

## What gets committed

Two commits, both small:

1. `feat(web): hide tombstoned comments from sidebar` — covers all three files (ThreadCard, CommentSidebar, document.tsx anchor filter) + the new test.
2. (Optional, if the test file ends up substantial) — split test into its own commit.

Single commit is fine for this scope.
