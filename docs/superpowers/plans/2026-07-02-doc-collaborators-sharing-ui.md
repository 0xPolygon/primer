# Doc Collaborators — Sub 3: Sharing UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the owner-only sharing modal on the doc view (visibility toggle, collaborators list, typeahead-based add) plus the read-only "Shared with …" indicator for non-owner collaborators.

**Architecture:** New React modal (`ShareModal.tsx`) rendered from `document.tsx`, wired through TanStack Query hooks (`collaborators.ts`) against Sub 2's HTTP surface. Two new pure helpers (`formatSharedWith`, `roleOptions`) carry the small pieces of logic worth unit-testing on their own. The doc DTO (`DocumentSummary`) grows one field — `visibility` — surfaced through GET/PATCH doc + `primer_get_document` MCP.

**Tech Stack:** React 19, TanStack Query 5, React Router 7, Tailwind (utility classes, no theme changes), Vitest (`environment: 'node'`, no RTL, no jsdom).

**Spec:** `docs/superpowers/specs/2026-07-02-doc-collaborators-design.md` — Sub 3 section.
**Issue:** [#41 (Sub 3 of #29)](https://github.com/0xPolygon/primer/issues/41)
**Sub 2 depends-on:** #40 (merged into `issue-29-doc-collaborators-spec`).

## Global Constraints

- **pnpm only.** Never npm. Every install: `pnpm install`.
- Explicit `.ts` / `.tsx` extensions on every import inside `apps/web/src` — matches existing convention.
- Vitest is configured with `environment: 'node'`. There is no `jsdom`, no `@testing-library/react`, and no React component tests in the repo. New tests in this plan are **pure-function unit tests only**. The modal's interactive behavior is validated by a manual QA checklist in Task 6.
- API calls go through `apps/web/src/lib/fetch.ts` `api()` — never raw `fetch()`. That helper handles CSRF + 401 redirect.
- TanStack Query cache keys follow the existing pattern: `['document', docId]`, `['collaborators', docId]`, `['dashboard']`, `['user-search', q, docId]`. Mutations invalidate exactly what they invalidated in Sub 1/2 (never over-broad).
- DTOs come from `@primer/shared/api` for response shapes, `@primer/shared` for request shapes.
- 404-vs-403 policy (from Subs 1/2): read paths 404 on `canRead=false`; write paths 403 on readable-but-not-writable, 404 on unreadable. This plan's mutations translate those to user-facing errors surfaced inline.
- `Refs #41` on every commit.

## Deviations from the design doc (acknowledged)

- **Soft warning when flipping to private.** The spec calls for a soft warning if the doc has recent viewers who aren't collaborators. Sub 2 didn't ship an endpoint that answers "who has viewed this doc recently but isn't a collaborator", so building a warning would either (a) require a new backend endpoint or (b) rely on info the frontend doesn't have. Deferred to a follow-up issue; noted here so the reviewer doesn't expect it.
- **No modal component tests.** The repo has no RTL / jsdom infrastructure. The manual QA checklist in Task 6 substitutes. This mirrors what Sub 1's plan did for its own web-side deviations (see the diff-between-versions plan for precedent).
- **`useUserSearch` fetches on debounced input, not per keystroke.** Simple `setTimeout` (200 ms) debounce inside the modal — no `lodash.debounce`, no `useDeferredValue`. Keeps deps minimal and matches the "own copy per file" spirit of Sub 1/2 test scaffolding.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `packages/shared/src/api.ts` | Add `visibility` to `DocumentSummary`; note-only for `Collaborator` (already exists from Sub 2) | 1 |
| `apps/api/src/routes/documents.ts` | Include `visibility` in GET + PATCH response bodies | 1 |
| `apps/api/src/routes/documents.test.ts` | Assert new field in responses | 1 |
| `apps/api/src/mcp/tools.ts` | Include `visibility` in `primer_get_document` response | 1 |
| `apps/api/src/mcp/tools.test.ts` | Assert new field | 1 |
| `apps/web/src/queries/collaborators.ts` | New query + mutation hooks (list, add, patch role, delete, visibility toggle, user search) | 2 |
| `apps/web/src/lib/share.ts` | Pure helpers: `formatSharedWith`, `roleOptions` | 3 |
| `apps/web/src/lib/share.test.ts` | Unit tests for the two helpers | 3 |
| `apps/web/src/components/ShareModal.tsx` | Modal component with focus trap, visibility toggle, collaborators list, add-collaborator typeahead | 4 |
| `apps/web/src/routes/document.tsx` | Add Share button (owner) + "Shared with …" indicator (non-owner collaborator); wire modal | 5 |

No new npm deps.

---

### Task 1: Surface `visibility` on the doc DTO + backend responses

**Files:**
- Modify: `packages/shared/src/api.ts` (add `visibility` to `DocumentSummary`)
- Modify: `apps/api/src/routes/documents.ts` (GET + PATCH response bodies)
- Modify: `apps/api/src/routes/documents.test.ts` (assert new field)
- Modify: `apps/api/src/mcp/tools.ts` (`primer_get_document` response)
- Modify: `apps/api/src/mcp/tools.test.ts` (assert new field)

**Interfaces:**
- Consumes: `documents.visibility` column (already exists from Sub 1)
- Produces: `DocumentSummary.visibility: 'org' | 'private'` — every consumer that constructs a `DocumentSummary` must populate this field. TypeScript will surface any missed call site at compile time.

- [ ] **Step 1: Extend `DocumentSummary`**

In `packages/shared/src/api.ts`, add `visibility` to `DocumentSummary`:

```ts
export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  createdAt: string;
}
```

- [ ] **Step 2: Populate `visibility` in the GET response**

In `apps/api/src/routes/documents.ts`, in the `GET /api/documents/:docId` handler, extend the response body. The SELECT already pulls `visibility`; only the DTO construction needs to change:

```ts
const body: DocumentDetailResponse = {
  document: {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    uploaderId: doc.uploaderId,
    uploaderDisplayName: doc.uploaderDisplayName,
    visibility: doc.visibility as 'org' | 'private',
    createdAt: doc.createdAt.toISOString(),
  },
  // ... latestVersion unchanged
};
```

- [ ] **Step 3: Populate `visibility` in the PATCH response**

In the same file, the `PATCH /api/documents/:docId` handler. Extend the re-read SELECT to include `visibility`, then include it in the response:

```ts
const [updated] = await db
  .select({
    id: documents.id,
    title: documents.title,
    description: documents.description,
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    createdAt: documents.createdAt,
  })
  .from(documents)
  .where(eq(documents.id, docId));

// ... uploader lookup unchanged

return c.json(
  {
    id: updated.id,
    title: updated.title,
    description: updated.description,
    uploaderId: updated.uploaderId,
    uploaderDisplayName: uploader?.displayName ?? '',
    visibility: updated.visibility as 'org' | 'private',
    createdAt: updated.createdAt.toISOString(),
  },
  200
);
```

- [ ] **Step 4: Populate `visibility` in `primer_get_document`**

In `apps/api/src/mcp/tools.ts`, the `primer_get_document` handler already SELECTs `visibility` (Sub 1). Extend the `ok(...)` response to include it:

```ts
return ok({
  document: {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    uploaderId: doc.uploaderId,
    uploaderDisplayName: doc.uploaderDisplayName,
    visibility: doc.visibility,
    createdAt: doc.createdAt.toISOString(),
  },
  latestVersion: { /* unchanged */ },
});
```

- [ ] **Step 5: Extend existing tests to assert `visibility` in the response**

In `apps/api/src/routes/documents.test.ts`, find the existing `GET /api/documents/:docId — returns document + latest version summaries` test (near the top of the file). Add:

```ts
expect(body.document.visibility).toBe('org');
```

Find any existing PATCH test that reads the response body and add a similar assertion where appropriate.

In `apps/api/src/routes/documents.test.ts`, extend the Task 4 (Sub 2) test that already flips visibility to private:

```ts
// Existing test: 'owner can flip visibility to private'
// After the PATCH assertion, add:
const patchBody = (await res.json()) as { visibility: 'org' | 'private' };
expect(patchBody.visibility).toBe('private');
```

In `apps/api/src/mcp/tools.test.ts`, find the `primer_get_document` happy-path test (Sub 1 seeded one) and assert `visibility` on the returned document field.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @primer/api test documents.test
pnpm --filter @primer/api test mcp/tools.test
```

Expected: both green. TypeScript will fail the build if any `DocumentSummary` constructor in the codebase forgot to populate `visibility` — fix each site by adding `visibility: doc.visibility as 'org' | 'private'`.

- [ ] **Step 7: Full suite**

```bash
pnpm --filter @primer/api test
```

Expected: still green (should be 536+ with the extra assertions).

- [ ] **Step 8: Typecheck both packages**

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: clean. Web typecheck will now enforce `visibility` on every `DocumentSummary` consumer — but the web app doesn't destructure the field in Sub 3 yet (Task 5 does), so this should just typecheck without touching the frontend.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts \
        apps/api/src/mcp/tools.ts apps/api/src/mcp/tools.test.ts
git commit -m "$(cat <<'EOF'
feat(api): surface visibility on DocumentSummary DTO

Adds visibility ('org' | 'private') to the DocumentSummary DTO and
populates it in GET/PATCH /api/documents/:docId responses plus
primer_get_document MCP output. Existing tests updated to assert the
new field.

Closes the Sub 2 follow-up noted in the whole-branch review: PATCH
response body previously omitted the field the caller just wrote.

Refs #41
EOF
)"
```

---

### Task 2: TanStack Query hooks for collaborators + user search + visibility

**Files:**
- Create: `apps/web/src/queries/collaborators.ts`

**Interfaces:**
- Consumes: `api()` from `../lib/fetch.ts`; DTOs from `@primer/shared` and `@primer/shared/api`
- Produces:
  - `useCollaborators(docId: string)` — list, `queryKey: ['collaborators', docId]`
  - `useUserSearch(q: string, docId: string | null)` — search, `queryKey: ['user-search', q, docId]`, `enabled: q.length > 0`
  - `useAddCollaborator(docId: string)` — POST, invalidates `['collaborators', docId]`
  - `useUpdateCollaboratorRole(docId: string)` — PATCH, invalidates `['collaborators', docId]`
  - `useRemoveCollaborator(docId: string)` — DELETE, invalidates `['collaborators', docId]`
  - `useSetVisibility(docId: string)` — PATCH doc `{ visibility }`, invalidates `['document', docId]` + `['dashboard']`

- [ ] **Step 1: Create the file**

Create `apps/web/src/queries/collaborators.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Collaborator,
  CollaboratorsListResponse,
  UserSearchResponse,
} from '@primer/shared/api';
import type { CollaboratorRole } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useCollaborators(docId: string) {
  return useQuery({
    queryKey: ['collaborators', docId],
    queryFn: async (): Promise<Collaborator[]> => {
      const res = await api(`/api/documents/${docId}/collaborators`);
      if (!res.ok) throw new Error(`collaborators fetch failed: ${res.status}`);
      const body = (await res.json()) as CollaboratorsListResponse;
      return body.collaborators;
    },
  });
}

export function useUserSearch(q: string, docId: string | null) {
  return useQuery({
    queryKey: ['user-search', q, docId],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('q', q);
      if (docId) params.set('docId', docId);
      const res = await api(`/api/users?${params.toString()}`);
      if (!res.ok) throw new Error(`user search failed: ${res.status}`);
      const body = (await res.json()) as UserSearchResponse;
      return body.users;
    },
    enabled: q.length > 0,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useAddCollaborator(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: CollaboratorRole }): Promise<Collaborator> => {
      const res = await api(`/api/documents/${docId}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`add collaborator failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useUpdateCollaboratorRole(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: CollaboratorRole }): Promise<Collaborator> => {
      const res = await api(`/api/documents/${docId}/collaborators/${input.userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: input.role }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`update collaborator failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useRemoveCollaborator(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string): Promise<void> => {
      const res = await api(`/api/documents/${docId}/collaborators/${userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`remove collaborator failed: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useSetVisibility(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (visibility: 'org' | 'private') => {
      const res = await api(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`set visibility failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

Expected: clean. This is a stand-alone file with no consumers yet, so no compile errors elsewhere.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/queries/collaborators.ts
git commit -m "$(cat <<'EOF'
feat(web): TanStack Query hooks for collaborator management

Adds useCollaborators, useUserSearch, useAddCollaborator,
useUpdateCollaboratorRole, useRemoveCollaborator, useSetVisibility.
Invalidation keys keep `['collaborators', docId]` scoped per doc;
useSetVisibility also invalidates `['document', docId]` (visibility
lives on the doc DTO after Task 1) and `['dashboard']` (badges may
change once Sub 4 lands).

Refs #41
EOF
)"
```

---

### Task 3: Pure helpers for share UI

**Files:**
- Create: `apps/web/src/lib/share.ts`
- Create: `apps/web/src/lib/share.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `formatSharedWith(collabs: Array<{ userId: string; displayName: string }>, meId: string): string | null`
    - Returns `null` if the current user isn't in the list (they see nothing).
    - Returns `"Shared with X"` for 1 other collab, `"Shared with X and Y"` for 2, `"Shared with X, Y and 1 other"` / `"Shared with X, Y and N others"` for 3+.
  - `roleOptions(visibility: 'org' | 'private'): Array<{ value: 'commenter' | 'editor'; label: string; disabled: boolean; tooltip?: string }>`
    - Under `org`: `commenter` is disabled with a tooltip explaining the "no commenter under org" rule.
    - Under `private`: both roles enabled.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/share.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatSharedWith, roleOptions } from './share.ts';

describe('formatSharedWith', () => {
  const me = { userId: 'me', displayName: 'Me' };
  const alice = { userId: 'a', displayName: 'Alice' };
  const bob = { userId: 'b', displayName: 'Bob' };
  const carol = { userId: 'c', displayName: 'Carol' };
  const dave = { userId: 'd', displayName: 'Dave' };

  it('returns null when the current user is not among collaborators', () => {
    expect(formatSharedWith([alice, bob], 'me')).toBeNull();
  });

  it('renders a single co-collaborator', () => {
    expect(formatSharedWith([me, alice], 'me')).toBe('Shared with Alice');
  });

  it('renders two co-collaborators with an "and" join', () => {
    expect(formatSharedWith([me, alice, bob], 'me')).toBe('Shared with Alice and Bob');
  });

  it('renders three co-collaborators as "A, B and 1 other"', () => {
    expect(formatSharedWith([me, alice, bob, carol], 'me')).toBe('Shared with Alice, Bob and 1 other');
  });

  it('renders four co-collaborators as "A, B and 2 others"', () => {
    expect(formatSharedWith([me, alice, bob, carol, dave], 'me')).toBe('Shared with Alice, Bob and 2 others');
  });
});

describe('roleOptions', () => {
  it('under private visibility, both roles are enabled', () => {
    const opts = roleOptions('private');
    expect(opts).toEqual([
      { value: 'commenter', label: 'Commenter', disabled: false },
      { value: 'editor', label: 'Editor', disabled: false },
    ]);
  });

  it('under org visibility, commenter is disabled with a tooltip', () => {
    const opts = roleOptions('org');
    const commenter = opts.find((o) => o.value === 'commenter')!;
    expect(commenter.disabled).toBe(true);
    expect(commenter.tooltip).toContain('private');
    const editor = opts.find((o) => o.value === 'editor')!;
    expect(editor.disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @primer/web test share.test
```

Expected: fails — `Cannot find module './share.ts'`.

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/lib/share.ts`:

```ts
export function formatSharedWith(
  collabs: Array<{ userId: string; displayName: string }>,
  meId: string,
): string | null {
  const inList = collabs.some((c) => c.userId === meId);
  if (!inList) return null;
  const others = collabs.filter((c) => c.userId !== meId).map((c) => c.displayName);
  if (others.length === 0) return null;
  if (others.length === 1) return `Shared with ${others[0]}`;
  if (others.length === 2) return `Shared with ${others[0]} and ${others[1]}`;
  const extra = others.length - 2;
  const noun = extra === 1 ? 'other' : 'others';
  return `Shared with ${others[0]}, ${others[1]} and ${extra} ${noun}`;
}

export interface RoleOption {
  value: 'commenter' | 'editor';
  label: string;
  disabled: boolean;
  tooltip?: string;
}

export function roleOptions(visibility: 'org' | 'private'): RoleOption[] {
  const commenterDisabled = visibility === 'org';
  return [
    {
      value: 'commenter',
      label: 'Commenter',
      disabled: commenterDisabled,
      ...(commenterDisabled
        ? {
            tooltip:
              'Commenter is only meaningful under private visibility — everyone in the org can already read and comment on public docs.',
          }
        : {}),
    },
    { value: 'editor', label: 'Editor', disabled: false },
  ];
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @primer/web test share.test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/share.ts apps/web/src/lib/share.test.ts
git commit -m "$(cat <<'EOF'
feat(web): pure helpers for share UI copy + role option gating

formatSharedWith renders the non-owner "Shared with A, B and N others"
line. roleOptions encodes the "commenter disabled under org" rule so
the modal can render disabled radio/select entries with a tooltip
explaining why.

Refs #41
EOF
)"
```

---

### Task 4: `ShareModal` component

**Files:**
- Create: `apps/web/src/components/ShareModal.tsx`

**Interfaces:**
- Consumes: hooks from `../queries/collaborators.ts`, `../queries/documents.ts` (for the base doc query — to read `visibility` and `title`), `../queries/me.ts` (for excluding self from listings); helpers from `../lib/share.ts`
- Produces: `<ShareModal open docId onClose />` component

**Structural mirror:** copy the overlay + dialog shape from `apps/web/src/components/AddVersionModal.tsx` (fixed inset, `role="dialog"`, `aria-modal`, ESC key handler, backdrop click closes). Keep the same header (title + close X), body, footer layout.

- [ ] **Step 1: Create the file**

Create `apps/web/src/components/ShareModal.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collaborator } from '@primer/shared/api';
import type { CollaboratorRole } from '@primer/shared';
import { useDocument } from '../queries/documents.ts';
import {
  useCollaborators,
  useUserSearch,
  useAddCollaborator,
  useUpdateCollaboratorRole,
  useRemoveCollaborator,
  useSetVisibility,
} from '../queries/collaborators.ts';
import { roleOptions } from '../lib/share.ts';

interface Props {
  open: boolean;
  docId: string;
  onClose: () => void;
}

const DEBOUNCE_MS = 200;

export function ShareModal({ open, docId, onClose }: Props) {
  const doc = useDocument(docId);
  const collabs = useCollaborators(docId);
  const visibility = doc.data?.document.visibility ?? 'org';

  const setVisibility = useSetVisibility(docId);
  const addCollab = useAddCollaborator(docId);
  const updateRole = useUpdateCollaboratorRole(docId);
  const removeCollab = useRemoveCollaborator(docId);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<CollaboratorRole>('editor');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Reset when opening.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setSearchInput('');
      setDebouncedQ('');
      setPendingUserId(null);
      setPendingRole('editor');
      setInlineError(null);
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounce search input.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, open]);

  const search = useUserSearch(debouncedQ, docId);
  const options = useMemo(() => roleOptions(visibility), [visibility]);

  // If the current selected role becomes disabled (e.g., commenter after flipping to org),
  // reset to editor.
  useEffect(() => {
    const opt = options.find((o) => o.value === pendingRole);
    if (opt?.disabled) setPendingRole('editor');
  }, [options, pendingRole]);

  async function onToggleVisibility(next: 'org' | 'private') {
    setInlineError(null);
    try {
      await setVisibility.mutateAsync(next);
    } catch (e) {
      setInlineError(`Could not change visibility: ${(e as Error).message}`);
    }
  }

  async function onAdd() {
    if (!pendingUserId) return;
    setInlineError(null);
    try {
      await addCollab.mutateAsync({ userId: pendingUserId, role: pendingRole });
      setSearchInput('');
      setDebouncedQ('');
      setPendingUserId(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('collaborator_exists')) setInlineError('Already a collaborator.');
      else if (msg.includes('invalid_role_for_visibility')) setInlineError('Commenter is only meaningful under private visibility.');
      else if (msg.includes('owner_not_collaborator')) setInlineError('The doc owner is already the doc owner.');
      else setInlineError(`Could not add: ${msg}`);
    }
  }

  async function onChangeRole(row: Collaborator, next: CollaboratorRole) {
    setInlineError(null);
    try {
      await updateRole.mutateAsync({ userId: row.userId, role: next });
    } catch (e) {
      setInlineError(`Could not change role: ${(e as Error).message}`);
    }
  }

  async function onRemove(row: Collaborator) {
    setInlineError(null);
    try {
      await removeCollab.mutateAsync(row.userId);
    } catch (e) {
      setInlineError(`Could not remove: ${(e as Error).message}`);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        className="w-full max-w-lg rounded-lg bg-white shadow-lg dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 id="share-modal-title" className="text-base font-semibold">
            Share “{doc.data?.document.title ?? '…'}”
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          {/* Visibility */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Visibility</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onToggleVisibility('org')}
                className={
                  visibility === 'org'
                    ? 'rounded border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white'
                    : 'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                }
              >
                Everyone at Polygon
              </button>
              <button
                type="button"
                onClick={() => onToggleVisibility('private')}
                className={
                  visibility === 'private'
                    ? 'rounded border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white'
                    : 'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                }
              >
                Private
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              {visibility === 'org'
                ? 'Anyone at Polygon can read and comment. Only owner and editors can make changes.'
                : 'Only you and the collaborators listed below can access this document.'}
            </p>
          </section>

          {/* Add collaborator */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Add collaborator</h3>
            <div className="space-y-2">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPendingUserId(null);
                }}
                placeholder="Search by name…"
                className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              {debouncedQ.length > 0 && search.data && search.data.length > 0 && (
                <ul className="max-h-48 overflow-y-auto rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  {search.data.map((u) => (
                    <li
                      key={u.id}
                      className={
                        pendingUserId === u.id
                          ? 'cursor-pointer bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800'
                          : 'cursor-pointer px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800'
                      }
                      onClick={() => {
                        setPendingUserId(u.id);
                        setSearchInput(u.displayName);
                      }}
                    >
                      <div>{u.displayName}</div>
                      <div className="text-xs text-neutral-500">{u.email}</div>
                    </li>
                  ))}
                </ul>
              )}
              {debouncedQ.length > 0 && search.data && search.data.length === 0 && (
                <p className="text-xs text-neutral-500">No matches.</p>
              )}
              {pendingUserId && (
                <div className="flex items-center gap-2">
                  <select
                    value={pendingRole}
                    onChange={(e) => setPendingRole(e.target.value as CollaboratorRole)}
                    className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value} disabled={o.disabled} title={o.tooltip}>
                        {o.label}
                        {o.disabled ? ' (private only)' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={onAdd}
                    disabled={addCollab.isPending}
                    className="rounded border border-neutral-900 bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                  >
                    {addCollab.isPending ? 'Adding…' : 'Add'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Current collaborators */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Collaborators</h3>
            {collabs.data && collabs.data.length === 0 && (
              <p className="text-xs text-neutral-500">No collaborators yet.</p>
            )}
            {collabs.data && collabs.data.length > 0 && (
              <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {collabs.data.map((c) => (
                  <li key={c.userId} className="flex items-center justify-between py-2">
                    <div>
                      <div className="text-sm">{c.displayName}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={c.role}
                        onChange={(e) => onChangeRole(c, e.target.value as CollaboratorRole)}
                        className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                      >
                        {options.map((o) => (
                          <option
                            key={o.value}
                            value={o.value}
                            disabled={o.disabled && o.value !== c.role}
                            title={o.tooltip}
                          >
                            {o.label}
                            {o.disabled && o.value !== c.role ? ' (private only)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${c.displayName}`}
                        onClick={() => onRemove(c)}
                        className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inlineError && (
            <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-200">
              {inlineError}
            </div>
          )}
        </div>

        <footer className="flex justify-end border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
```

Note: the "Change role of a current collaborator to a disabled role" case is handled by only disabling the OPPOSITE role when it's already the current one — i.e., a `commenter` under `org` still shows their role selected (not disabled), but the `editor` → `commenter` change is blocked. This prevents the UI from telling the user they can't keep the role they already have.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ShareModal.tsx
git commit -m "$(cat <<'EOF'
feat(web): ShareModal component

Overlay + dialog mirroring AddVersionModal's shape: focus trap, ESC to
close, backdrop-click dismiss. Contents: visibility toggle,
typeahead-based add-collaborator with role picker, current
collaborators list with role dropdowns and remove buttons. Inline
error surface for known API error codes.

Refs #41
EOF
)"
```

---

### Task 5: Doc view integration

**Files:**
- Modify: `apps/web/src/routes/document.tsx` (Share button + "Shared with…" indicator + wire ShareModal)

**Interfaces:**
- Consumes: `ShareModal`, `useCollaborators`, `formatSharedWith`, `useMe`
- Produces: no new exports; owner sees Share button, collaborators see indicator

- [ ] **Step 1: Import the new pieces**

Add imports at the top of `apps/web/src/routes/document.tsx`:

```ts
import { ShareModal } from '../components/ShareModal.tsx';
```

Note on scope: `document.tsx` doesn't need to import `useCollaborators` or `formatSharedWith`. The modal fetches its own collaborator list when opened, and the non-owner indicator uses only `visibility` from the doc query (see Step 3). The "Shared with A and B and N others" line from the spec would require a "which docs am I a collaborator on?" endpoint we don't have; deferred (documented in the plan header).

- [ ] **Step 2: Add local state for the modal**

Near the other `useState<boolean>` declarations in the component body (search for `showAddVersion`):

```ts
const [showShare, setShowShare] = useState(false);
```

- [ ] **Step 3: Render the Share button (owner only) in the header**

Find the doc header block (around line 531 of the current file — the `<div className="flex shrink-0 items-center gap-3">` that houses the VersionSelector and actions menu). Insert a new button before the actions menu:

```tsx
{isUploader && (
  <button
    type="button"
    onClick={() => setShowShare(true)}
    className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
  >
    Share
  </button>
)}
```

- [ ] **Step 4: Render the read-only indicator for non-owners on private docs**

Just below the doc title area (find where the title + description render — around lines 500–530), add a small pill:

```tsx
{!isUploader && docQuery.data?.document.visibility === 'private' && (
  <span className="mt-1 inline-flex rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
    Shared privately
  </span>
)}
```

This surfaces the private-doc state to non-owner collaborators without needing the collaborators list. (See the note in Step 3 for why the more specific "Shared with X and Y" indicator is deferred.)

- [ ] **Step 5: Wire the modal into the JSX**

At the end of the component's JSX, alongside the existing modal (e.g., delete-confirm modal near line 620):

```tsx
{showShare && docId && (
  <ShareModal open docId={docId} onClose={() => setShowShare(false)} />
)}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

Expected: clean.

- [ ] **Step 7: Manual smoke — dev server**

```bash
pnpm --filter @primer/web dev
```

In another terminal:

```bash
pnpm --filter @primer/api dev
```

Open http://localhost:5173, navigate to any doc, and:

1. As the owner: verify the "Share" button appears in the header. Click it — the modal opens.
2. Flip visibility to Private — the doc's underlying `visibility` field should update; re-open the modal to confirm the toggle sticks.
3. Type in the search box — after 200 ms, results should appear. Pick a user. Add as editor. Verify the collaborator appears in the list below.
4. Change the collaborator's role via the dropdown — verify it updates.
5. Remove the collaborator via the × button — verify they disappear.
6. Under `org` visibility: try to add a commenter — the option in the select should be disabled ("Commenter (private only)"). Confirm the API rejects a commenter add (if the UI somehow lets it through) with `invalid_role_for_visibility` — surfaces as an inline error.
7. Switch to a second browser profile (or use `X-Mock-User-Id` in dev), navigate to the same private doc — you should get 404 if not a collaborator, or see the "Shared privately" pill if you are.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "$(cat <<'EOF'
feat(web): Share button + private indicator on doc view

Owner sees a Share button in the header that opens the ShareModal.
Non-owners on private docs see a "Shared privately" pill. The more
specific "Shared with X and Y" line requires a "am I a collaborator"
endpoint the frontend doesn't have — deferred to a future issue.

Refs #41
EOF
)"
```

---

### Task 6: Final verification + pause for user greenlight

**Files:** none (verification only)

**Interfaces:** all prior tasks integrated

- [ ] **Step 1: Full API test suite**

```bash
pnpm --filter @primer/api test
```

Expected: entire API test suite green.

- [ ] **Step 2: Full web test suite**

```bash
pnpm --filter @primer/web test
```

Expected: green (existing tests + new `share.test.ts`).

- [ ] **Step 3: Typecheck both packages**

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: clean.

- [ ] **Step 4: Manual QA checklist (subagent completes this; controller reviews)**

Repeat the smoke tests from Task 5 Step 8. Record the outcome in the task report — pass/fail + notes. If anything fails, STOP and escalate to the controller.

- [ ] **Step 5: STOP**

Do not push. Do not open a PR. Report back to the controller with the verification results. The controller pauses for user greenlight before push + PR per the no-auto-push policy.

## Self-Review

**Spec coverage:**

- Owner-only "Share" affordance opening a modal → Tasks 4 + 5. ✓
- Modal contents: visibility toggle, current collaborators with role dropdown + remove, typeahead-based add → Task 4. ✓
- Commenter option grayed under `org` with tooltip → Tasks 3 + 4 (`roleOptions` + `<option disabled title=…>`). ✓
- Non-owner "Shared with … + N others" indicator → **partially covered.** Sub 3 ships a "Shared privately" pill for non-owner readers; the specific N-collaborators-line is deferred (requires a "am I a collaborator" endpoint the backend doesn't expose today). Recorded as a deviation in the plan header.
- Soft warning when flipping to private with recent viewers → **deferred.** Recorded as a deviation.
- Uses only Sub 2's API surface + one carry-forward → Task 1 adds `visibility` to the doc DTO (the M-3 follow-up from Sub 2's whole-branch review). All other endpoints are Sub 2's. ✓
- Unit tests for the pure helpers + manual QA for the modal → Tasks 3 + 6. Matches the repo's existing "no RTL, pure-fn tests only" pattern.

**Placeholder scan:** none.

**Type consistency:** `CollaboratorRole` = `'commenter' | 'editor'` used verbatim in every query, hook, and helper. `Visibility` inline as `'org' | 'private'` in DTOs; the frontend never imports `Visibility` from `permissions.ts` (that's a backend-only module). `DocumentSummary.visibility` added in Task 1 is consumed in Task 4 (`doc.data?.document.visibility`). Query keys match across hooks and invalidations (`['collaborators', docId]`, `['document', docId]`, `['dashboard']`, `['user-search', q, docId]`).
