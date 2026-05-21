# Hide Deleted Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rendering tombstoned comments anywhere in the Primer web UI. Threads whose every comment is deleted disappear from the sidebar and stop painting highlights in the artifact iframe; threads with surviving replies stay visible with the first survivor as the "root."

**Architecture:** Pure client-side filter. Two helpers (`liveComments(thread)` and `hasLiveComments(thread)`) live in `apps/web/src/lib/liveComments.ts` and are wired into `CommentSidebar` (drop tombstone-only threads, recount header), `ThreadCard` (derive `[first, ...replies]` from non-tombstoned comments, drop the "deleted by author" branch), and `DocumentPage` (filter `anchorsForCompanion` so the iframe doesn't paint orphan highlights). No backend changes; the API still returns tombstones — we just don't display them.

**Tech Stack:** TypeScript, React 19, Vitest 4 (pure-helper test, following the existing `exportComments.test.ts` precedent — no React Testing Library is in use).

**Spec:** `docs/superpowers/specs/2026-05-21-hide-deleted-comments-design.md`

---

## File map

- **Create** `apps/web/src/lib/liveComments.ts` — exports `liveComments(thread)` and `hasLiveComments(thread)`. Pure functions over `ThreadDTO`.
- **Create** `apps/web/src/lib/liveComments.test.ts` — Vitest covering: tombstoned-only thread, mixed thread, all-live thread, edge cases.
- **Modify** `apps/web/src/components/CommentSidebar.tsx` — derive `visibleThreads` via `hasLiveComments`; use it for the sorted/visible chain, the header count, the collapsed-state badge count, and the collapsed-state thread dots.
- **Modify** `apps/web/src/components/ThreadCard.tsx` — destructure `[first, ...replies] = liveComments(thread)` instead of `thread.comments`; drop the `isTombstoned` constant and all three of its branches in `CommentRow`.
- **Modify** `apps/web/src/routes/document.tsx` — filter `anchorsForCompanion` so threads with no live comments don't seed iframe highlights.

---

## Task 1: Create the filter helpers + tests

**Files:**
- Create: `apps/web/src/lib/liveComments.ts`
- Create: `apps/web/src/lib/liveComments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/liveComments.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ThreadDTO, CommentDTO } from '@primer/shared';
import { liveComments, hasLiveComments } from './liveComments.ts';

function comment(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    threadId: 't-1',
    authorId: 'u1',
    authorDisplayName: 'Author',
    body: 'hi',
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: null,
    deletedAt: null,
    mentions: [],
    ...over,
  };
}

function thread(over: Partial<ThreadDTO> = {}): ThreadDTO {
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    versionId: 'v-1',
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
    resolvedAt: null,
    resolvedBy: null,
    resolvedByDisplayName: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    comments: [comment()],
    ...over,
  };
}

describe('liveComments', () => {
  it('returns all comments when none are tombstoned', () => {
    const t = thread({
      comments: [comment({ body: 'a' }), comment({ body: 'b' })],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['a', 'b']);
  });

  it('excludes tombstoned comments', () => {
    const t = thread({
      comments: [
        comment({ body: 'kept', deletedAt: null }),
        comment({ body: 'gone', deletedAt: '2026-05-20T11:00:00.000Z' }),
      ],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['kept']);
  });

  it('returns an empty array when every comment is tombstoned', () => {
    const t = thread({
      comments: [comment({ deletedAt: '2026-05-20T11:00:00.000Z' })],
    });
    expect(liveComments(t)).toEqual([]);
  });

  it('preserves comment order', () => {
    const t = thread({
      comments: [
        comment({ body: '1', createdAt: '2026-05-20T10:00:00.000Z' }),
        comment({ body: '2', createdAt: '2026-05-20T10:01:00.000Z', deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ body: '3', createdAt: '2026-05-20T10:02:00.000Z' }),
      ],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['1', '3']);
  });
});

describe('hasLiveComments', () => {
  it('is true when at least one comment survives', () => {
    const t = thread({
      comments: [
        comment({ deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ deletedAt: null }),
      ],
    });
    expect(hasLiveComments(t)).toBe(true);
  });

  it('is false when every comment is tombstoned', () => {
    const t = thread({
      comments: [
        comment({ deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ deletedAt: '2026-05-20T11:01:00.000Z' }),
      ],
    });
    expect(hasLiveComments(t)).toBe(false);
  });

  it('is false when the comments array is empty', () => {
    const t = thread({ comments: [] });
    expect(hasLiveComments(t)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @primer/web test -- liveComments.test.ts`
Expected: FAIL — module `./liveComments.ts` does not exist.

- [ ] **Step 3: Create the helper**

Create `apps/web/src/lib/liveComments.ts`:

```ts
import type { CommentDTO, ThreadDTO } from '@primer/shared';

/** All comments in the thread that have NOT been tombstoned (deletedAt is null). */
export function liveComments(thread: ThreadDTO): CommentDTO[] {
  return thread.comments.filter((c) => c.deletedAt === null);
}

/** True when at least one comment in the thread is non-tombstoned. */
export function hasLiveComments(thread: ThreadDTO): boolean {
  return thread.comments.some((c) => c.deletedAt === null);
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm --filter @primer/web test -- liveComments.test.ts`
Expected: PASS — all 7 cases succeed.

- [ ] **Step 5: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: all three projects report `Done`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/liveComments.ts apps/web/src/lib/liveComments.test.ts
git commit -m "feat(web): add liveComments / hasLiveComments helpers"
```

---

## Task 2: Wire helpers into the three call sites

This task lands the user-visible change. Three files are modified together because they share a single behavioral concern: don't render tombstoned content. Splitting would let an intermediate commit briefly desync the sidebar from the iframe.

**Files:**
- Modify: `apps/web/src/components/CommentSidebar.tsx`
- Modify: `apps/web/src/components/ThreadCard.tsx`
- Modify: `apps/web/src/routes/document.tsx`

### CommentSidebar changes

Add the import. After the existing imports at the top, add:

```ts
import { hasLiveComments } from '../lib/liveComments.ts';
```

Find the block (currently around lines 67-89) that computes `sortedThreads`, `visible`, and `activeCount`. Insert a `visibleThreads` step between `sortedThreads` and `visible`. The resulting block reads:

```ts
  const sortedThreads = useMemo<ThreadDTO[]>(() => {
    if (!positionsByAnchorId || positionsByAnchorId.size === 0) {
      return [...threads].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }
    return [...threads].sort((a, b) => {
      const pa = positionsByAnchorId.get(a.id);
      const pb = positionsByAnchorId.get(b.id);
      if (pa?.drifted && !pb?.drifted) return 1;
      if (!pa?.drifted && pb?.drifted) return -1;
      const ya = pa?.y ?? Number.POSITIVE_INFINITY;
      const yb = pb?.y ?? Number.POSITIVE_INFINITY;
      if (ya !== yb) return ya - yb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [threads, positionsByAnchorId]);

  const visibleThreads = sortedThreads.filter(hasLiveComments);

  const visible = hideResolved
    ? visibleThreads.filter((t) => t.resolvedAt === null)
    : visibleThreads;
  const activeCount = visibleThreads.filter((t) => t.resolvedAt === null).length;
```

Two substantive changes:
1. New `visibleThreads` derived from `sortedThreads` via `.filter(hasLiveComments)`.
2. `visible` and `activeCount` are now derived from `visibleThreads` instead of `sortedThreads` / `threads`.

Update the collapsed-state header count (currently `{activeCount}`) and dot list. Find this block (around lines 91-128):

```tsx
  if (collapsed) {
    return (
      <div className="flex h-full w-9 flex-col items-center gap-2 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 py-2">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          ›
        </button>
        <span className="rounded-full border border-amber-300 dark:border-amber-700 bg-amber-100 dark:bg-amber-900/30 px-2 text-[9px] font-semibold text-neutral-700 dark:text-neutral-300">
          {activeCount}
        </span>
        <div className="flex w-full flex-1 flex-col items-center gap-1 pt-2">
          {sortedThreads.map((t) => (
            <button
              ...
            />
          ))}
        </div>
      </div>
    );
  }
```

Only change: `{sortedThreads.map((t) => (` becomes `{visibleThreads.map((t) => (`. The `activeCount` reference is already correct because we updated its derivation above. All other surface in this block (classes, structure) stays as-is.

Update the expanded-state header thread count. Find (around line 134):

```tsx
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">
          {threads.length} thread{threads.length === 1 ? '' : 's'}
        </span>
```

Change both references to use `visibleThreads.length`:

```tsx
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">
          {visibleThreads.length} thread{visibleThreads.length === 1 ? '' : 's'}
        </span>
```

Update the empty-state message at the bottom (around lines 189-193):

```tsx
        {visible.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            {threads.length === 0 ? 'No comments yet.' : 'No active threads (all resolved).'}
          </div>
        )}
```

Change `threads.length` to `visibleThreads.length` so the "no comments yet" message also fires when every thread has had all comments deleted:

```tsx
        {visible.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            {visibleThreads.length === 0 ? 'No comments yet.' : 'No active threads (all resolved).'}
          </div>
        )}
```

### ThreadCard changes

Add the import. After the existing imports at the top, add:

```ts
import { liveComments } from '../lib/liveComments.ts';
```

Find the destructure (currently around line 221):

```ts
  const [first, ...replies] = thread.comments;
```

Change to:

```ts
  const [first, ...replies] = liveComments(thread);
```

Find the `CommentRow` component (around lines 102-211) and remove tombstone-related code. The current top of the function (around lines 116-129):

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [editMentions, setEditMentions] = useState<string[]>(comment.mentions);
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const usersQ = useMentionableUsers();
  const isTombstoned = comment.deletedAt !== null;
  const canShowAuthorActions = !isTombstoned && !editing && isAuthor;
```

Becomes:

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [editMentions, setEditMentions] = useState<string[]>(comment.mentions);
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const usersQ = useMentionableUsers();
  const canShowAuthorActions = !editing && isAuthor;
```

(Drop the `isTombstoned` line; remove `!isTombstoned &&` from `canShowAuthorActions`.)

Find the "(edited)" italic (around lines 158-161):

```tsx
            {relativeTime(comment.createdAt)}
            {comment.updatedAt && !isTombstoned && (
              <span className="ml-1 italic text-neutral-400 dark:text-neutral-500">(edited)</span>
            )}
```

Becomes:

```tsx
            {relativeTime(comment.createdAt)}
            {comment.updatedAt && (
              <span className="ml-1 italic text-neutral-400 dark:text-neutral-500">(edited)</span>
            )}
```

Find the body-rendering ternary (around lines 165-208):

```tsx
      {isTombstoned ? (
        <div className="italic text-neutral-400 dark:text-neutral-500">deleted by author</div>
      ) : editing ? (
        <div className="mt-1">
          ... edit mode UI ...
        </div>
      ) : (
        <div className="mt-0.5 leading-snug text-neutral-900 dark:text-neutral-100">
          {renderMentions(comment.body, comment.mentions, usersQ.data ?? [])}
        </div>
      )}
```

Becomes:

```tsx
      {editing ? (
        <div className="mt-1">
          ... edit mode UI ...
        </div>
      ) : (
        <div className="mt-0.5 leading-snug text-neutral-900 dark:text-neutral-100">
          {renderMentions(comment.body, comment.mentions, usersQ.data ?? [])}
        </div>
      )}
```

Drop the entire `isTombstoned ?` branch and its `<div>...deleted by author</div>` content. The other two branches (`editing` and the default body view) remain unchanged.

### DocumentPage changes

Add the import. After the existing imports near the top of `apps/web/src/routes/document.tsx`, add:

```ts
import { hasLiveComments } from '../lib/liveComments.ts';
```

Find the `anchorsForCompanion` `useMemo` (currently around lines 100-103):

```ts
  const anchorsForCompanion = useMemo(
    () => threads.map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );
```

Change to:

```ts
  const anchorsForCompanion = useMemo(
    () => threads.filter(hasLiveComments).map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );
```

### Verification

- [ ] **Step 1: Apply all three file modifications above.**

Use `Edit` for each substitution, taking care not to accidentally remove unrelated lines.

- [ ] **Step 2: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: all three projects `Done`. No new errors.

- [ ] **Step 3: Workspace test suite**

Run: `pnpm -r test --run`
Expected: every suite passes (no regressions). The `liveComments.test.ts` suite from Task 1 plus 7 new tests is included.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/CommentSidebar.tsx apps/web/src/components/ThreadCard.tsx apps/web/src/routes/document.tsx
git commit -m "feat(web): hide tombstoned comments from sidebar"
```

---

## Task 3: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: `Done`.

- [ ] **Step 2: Full test suite**

Run: `pnpm -r test --run`
Expected: all suites pass. The total Vitest count should rise by 7 (new tests in `liveComments.test.ts`) versus the pre-plan baseline.

- [ ] **Step 3: Build**

Run: `pnpm -r build`
Expected: api + web both build cleanly.

- [ ] **Step 4: Grep sweep for stale tombstone references**

```bash
rg -n 'isTombstoned' apps/web/src
rg -n 'deleted by author' apps/web/src
```

Expected: zero hits in both. If `isTombstoned` appears anywhere in `apps/web/src`, the Task 2 edits missed a spot.

- [ ] **Step 5: Manual smoke (deferred to controller / human in non-interactive contexts)**

Start the dev environment and verify:

1. Open a doc that has a thread with two comments. Delete the second comment. The thread card should now show only the first comment — no "deleted by author" line.
2. Delete the remaining comment. The whole thread card should vanish, AND the highlight in the artifact iframe should disappear at the same time (`anchorsForCompanion` filter).
3. Open a thread, add a reply, then delete the original (root) comment. The reply should remain visible as the "root" of the card (without the dashed-divider reply indent).
4. The sidebar header count ("N thread(s)") should match the number of cards visible. In the collapsed state, the badge count and dot list should agree.
5. The "no comments yet" empty-state copy should now also appear if every thread has been deleted away (rather than the original "all resolved" copy).

In a non-interactive subagent context, report Step 5 as deferred.

- [ ] **Step 6: No commit needed** — this task is verification only. If Step 4 finds stale references, fix them and add a small follow-up commit.

---

## Self-review checklist (for the implementer)

| Spec section                                                       | Task(s)            |
|--------------------------------------------------------------------|--------------------|
| Helper functions `liveComments` + `hasLiveComments`                | Task 1             |
| Vitest covering tombstone-only / mixed / all-live / order          | Task 1 Step 1      |
| `CommentSidebar` filter: drop threads with no live comments        | Task 2 (Sidebar)   |
| `CommentSidebar` recount header from filtered list                 | Task 2 (Sidebar)   |
| `CommentSidebar` collapsed badge + dot list use filtered list      | Task 2 (Sidebar)   |
| `ThreadCard` destructure from `liveComments(thread)`               | Task 2 (ThreadCard)|
| `ThreadCard` drop `isTombstoned` branches in `CommentRow`          | Task 2 (ThreadCard)|
| `DocumentPage` filter `anchorsForCompanion`                        | Task 2 (DocumentPage) |
| First surviving reply becomes visible root (no indent)             | Task 2 (ThreadCard) — falls out of destructure |
| Empty-state message updates to use `visibleThreads.length`         | Task 2 (Sidebar)   |
| No tombstone references remain anywhere                            | Task 3 Step 4      |
| Manual smoke for delete → vanish flow                              | Task 3 Step 5      |

Type consistency check: `liveComments(thread)` returns `CommentDTO[]`, used in `ThreadCard`'s destructure. `hasLiveComments(thread)` returns `boolean`, used in `CommentSidebar`'s `sortedThreads.filter(...)` and `DocumentPage`'s `threads.filter(...)`. Both helpers are imported from the same path: `'../lib/liveComments.ts'`. The relative path is correct from both `apps/web/src/components/*.tsx` and `apps/web/src/routes/*.tsx`.
