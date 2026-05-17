# Primer Sub-Project 4 (Versioning + Soft-delete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 1 by adding multi-version-per-document with an add-version flow, version-pinned URLs and a version selector, read-mostly mode on old versions, inline metadata editing for uploaders, soft-delete with a 30-day reversible window, and a hard-purge job — plus a new shared `FileDropZone` component that replaces the default ugly `<input type="file">` in both the standalone UploadPage and the new AddVersionModal.

**Architecture:** No new tables and no SQL migration — every column needed already exists from SP1 (`documents.deletedAt`, `versions.versionNumber` + unique index, `versions.versionNote`). Six new API endpoints + three modifications. New frontend components: `FileDropZone`, `EditableField`, `VersionSelector`, `AddVersionModal`, `RestoreButton`. Purge job is a single function with two invocation paths (in-process interval + `pnpm db:purge` CLI). All uploader-only authorization stays on the SP1 mock-user middleware predicate; SP5 will swap the middleware without changing the predicate.

**Tech Stack:** TypeScript 6 + Hono 4 (Node 24) + Drizzle 0.45 + postgres.js + Vitest 4 on the API; React 19 + Vite 8 + TanStack Query 5 + Tailwind 4 on the web side.

**Companion spec:** `docs/superpowers/specs/2026-05-17-primer-versioning-soft-delete-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Start from `master` (currently at `1ddcea5`, the SP4 spec commit). T1 creates `feat/versioning-soft-delete`.
- Postgres is up (`pnpm db:up` if not). `.env` exists at repo root.
- pnpm 11.1.0 at `~/.local/bin/pnpm`, Node 24 in the Nix store. **Every Bash command starts with:**
  ```bash
  export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
  ```
- SSH-key git signing works without prompting. Commit normally (no `--no-gpg-sign`).
- All work commits on `feat/versioning-soft-delete`. Final squash-merge to master is the last task.

---

## File map

```
packages/shared/src/
  api.ts                            # MOD — new DTOs (VersionSummary,
                                    #        DocumentPatchRequest,
                                    #        VersionPatchRequest,
                                    #        AddVersionResponse,
                                    #        DeletedDocumentEntry,
                                    #        DashboardResponse gains
                                    #        recentlyDeleted)

apps/api/src/
  routes/
    documents.ts                    # MOD — soft-delete 404, PATCH, DELETE,
                                    #        restore, add-version,
                                    #        list-versions
    documents.test.ts               # MOD
    versions.ts                     # NEW — PATCH /api/versions/:vid
    versions.test.ts                # NEW
    threads.ts                      # MOD — 409 on POST to non-latest
    threads.test.ts                 # MOD
    dashboard.ts                    # MOD — adds recentlyDeleted
    dashboard.test.ts               # MOD
  jobs/
    purge.ts                        # NEW — purgeExpiredDocuments +
                                    #        startPurgeInterval
    purge.test.ts                   # NEW
    purge-cli.ts                    # NEW — pnpm db:purge entry
  app.ts                            # MOD — register versions route
  index.ts                          # MOD — startPurgeInterval()
  package.json                      # MOD — db:purge script

apps/web/src/
  components/
    FileDropZone.tsx                # NEW
    EditableField.tsx               # NEW
    VersionSelector.tsx             # NEW
    AddVersionModal.tsx             # NEW
    RestoreButton.tsx               # NEW
    DocumentListRow.tsx             # MOD — DeletedDocumentRow variant
  queries/
    versions.ts                     # NEW — useVersionsQuery,
                                    #        useAddVersion,
                                    #        useEditVersionNote
    documents.ts                    # MOD — useEditDocument,
                                    #        useDeleteDocument,
                                    #        useRestoreDocument
    dashboard.ts                    # MOD — DashboardResponse uses new shape
  routes/
    upload.tsx                      # MOD — FileDropZone + polish
    document.tsx                    # MOD (T18 + T19) — selector, routing,
                                    #                  read-mostly, inline
                                    #                  edit, actions
    home.tsx                        # MOD — Recently deleted section,
                                    #        Add new version entry
  App.tsx                           # MOD — new versioned route

package.json (root)                 # MOD — db:purge passthrough
```

---

## Phase A — Shared types

### Task 1: Feature branch + new DTOs

**Files:**
- Modify: `packages/shared/src/api.ts`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/taylan/development/polygon/primer
git status   # confirm clean on master
git checkout -b feat/versioning-soft-delete
git log --oneline -3
```

- [ ] **Step 2: Append new DTOs to `api.ts`**

Open `packages/shared/src/api.ts`. After the existing exports (which already include `DashboardResponse`, `DashboardDocumentSummary`, `DashboardActivityEntry`), append:

```ts
export interface VersionSummaryDTO {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface VersionsListResponse {
  versions: VersionSummaryDTO[];
}

export interface DocumentPatchRequest {
  title?: string;
  description?: string | null;
}

export interface VersionPatchRequest {
  versionNote: string | null;
}

export interface AddVersionResponse {
  versionId: string;
  versionNumber: number;
  url: string;
}

export interface DeletedDocumentEntry {
  id: string;
  title: string;
  deletedAt: string;
  daysRemaining: number;
}
```

Then find the existing `DashboardResponse` interface and add the new field:

```ts
export interface DashboardResponse {
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
  recentlyDeleted: DeletedDocumentEntry[];   // NEW in SP4
}
```

Leave every other interface/type unchanged.

- [ ] **Step 3: Typecheck all three workspaces**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: all three clean. `apps/api` and `apps/web` don't yet use the new types so adding them is non-breaking.

- [ ] **Step 4: Commit**

```bash
git status
git add packages/shared/src/api.ts
git commit -m "feat(shared): DTOs for versioning, soft-delete, and recently-deleted"
git log --oneline -3
```

---

## Phase B — Documents API (soft-delete + CRUD)

### Task 2: GET `/api/documents/:docId` returns 404 for soft-deleted (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Append failing tests**

Open `apps/api/src/routes/documents.test.ts`. Append a new describe block at the end of the file (keep existing tests untouched):

```ts
describe('GET /api/documents/:docId — soft-delete visibility', () => {
  it('returns 404 when the document is soft-deleted, even for the uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-softdelete-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      // Soft-delete via direct DB write.
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not upsert document_views for a soft-deleted doc', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-softdelete-views-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      await app.request(`/api/documents/${upload.documentId}`);

      const rows = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Add `documents` to the imports if not already there:

```ts
import { documents, documentViews } from '@primer/shared/schema';
```

- [ ] **Step 2: Run — verify fail**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test documents
```

Expected: both new tests fail (handler returns 200 because it doesn't check `deletedAt` yet).

- [ ] **Step 3: Implement the guard**

In `apps/api/src/routes/documents.ts`, find the existing `app.get('/api/documents/:docId', ...)` handler. After the existing query for the document + version (which returns 404 if the doc doesn't exist), add a soft-delete check.

The minimal diff: after `if (docRows.length === 0) return c.json({ error: 'not_found' }, 404);`, add:

```ts
    if (docRows[0].deletedAt !== null) {
      return c.json({ error: 'not_found' }, 404);
    }
```

This requires `deletedAt` to be in the SELECT list. Find the existing `.select({...})` in the documents-GET handler and add `deletedAt: documents.deletedAt,` to the projection (alongside the other fields).

Also: the view-tracking upsert (added in SP3) must run AFTER the soft-delete check passes. Since the upsert happens later in the handler (just before the `return c.json(body, 200)`), it's naturally skipped when we return 404 early. No additional changes needed there.

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test documents
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 2 new tests pass; full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): GET /api/documents/:docId returns 404 for soft-deleted docs"
git log --oneline -3
```

---

### Task 3: PATCH `/api/documents/:docId` (uploader-only edit) (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/documents.test.ts`:

```ts
import type { DocumentPatchRequest } from '@primer/shared';

describe('PATCH /api/documents/:docId', () => {
  it('updates title by uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-doc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const body: DocumentPatchRequest = { title: 'New Title' };
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { id: string; title: string };
      expect(out.title).toBe('New Title');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates description (including null to clear)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-desc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const r1 = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'Updated desc' }),
      });
      expect(r1.status).toBe(200);
      expect(((await r1.json()) as { description: string | null }).description).toBe('Updated desc');

      const r2 = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: null }),
      });
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as { description: string | null }).description).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 400 when body is empty (no fields)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-empty-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 400 for empty title after trim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-empty-title-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      // Insert a doc owned by a different user.
      const otherUserId = 'other-user-patch';
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'op@p.t', displayName: 'OtherP' })
        .onConflictDoNothing();
      const docId = uuidv7();
      const versionId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: 1,
        storageKey: `v1/${versionId}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const res = await app.request(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Sneaky' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Cant edit' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Add `uuidv7`, `versions`, `users` to imports if missing:

```ts
import { v7 as uuidv7 } from 'uuid';
import { documents, documentViews, versions, users } from '@primer/shared/schema';
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test documents
```

Expected: 6 new tests fail (PATCH not handled — likely 405 or 404).

- [ ] **Step 3: Implement PATCH**

In `apps/api/src/routes/documents.ts`, inside the `registerDocumentRoutes` function (or wherever the existing GET handler lives), after the existing routes, add:

```ts
  app.patch('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    let payload: { title?: unknown; description?: unknown };
    try {
      payload = (await c.req.json()) as { title?: unknown; description?: unknown };
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(payload, 'title');
    const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description');
    if (!hasTitle && !hasDescription) {
      return c.json({ error: 'invalid_body', message: 'Provide title or description.' }, 400);
    }

    const updates: { title?: string; description?: string | null } = {};

    if (hasTitle) {
      if (typeof payload.title !== 'string') {
        return c.json({ error: 'invalid_body', message: 'title must be a string' }, 400);
      }
      const trimmed = payload.title.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        return c.json({ error: 'invalid_body', message: 'title must be 1–200 chars' }, 400);
      }
      updates.title = trimmed;
    }

    if (hasDescription) {
      if (payload.description === null) {
        updates.description = null;
      } else if (typeof payload.description === 'string') {
        const trimmed = payload.description.trim();
        if (trimmed.length > 2000) {
          return c.json({ error: 'invalid_body', message: 'description must be ≤2000 chars' }, 400);
        }
        updates.description = trimmed.length === 0 ? null : trimmed;
      } else {
        return c.json({ error: 'invalid_body', message: 'description must be string or null' }, 400);
      }
    }

    const [existing] = await db
      .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.deletedAt !== null) return c.json({ error: 'not_found' }, 404);
    if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    await db.update(documents).set(updates).where(eq(documents.id, docId));

    const [updated] = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.id, docId));

    const [uploader] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, updated.uploaderId));

    return c.json(
      {
        id: updated.id,
        title: updated.title,
        description: updated.description,
        uploaderDisplayName: uploader?.displayName ?? '',
        createdAt: updated.createdAt.toISOString(),
      },
      200
    );
  });
```

Ensure `users` is imported from `@primer/shared/schema` in `documents.ts`:

```ts
import { documents, versions, users, documentViews } from '@primer/shared/schema';
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test documents
pnpm --filter @primer/api typecheck
```

Expected: all PATCH tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): PATCH /api/documents/:docId (uploader-only edit)"
git log --oneline -3
```

---

### Task 4: DELETE + POST `/restore` (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/documents.test.ts`:

```ts
describe('DELETE /api/documents/:docId', () => {
  it('soft-deletes by uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-doc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { id: string; deletedAt: string };
      expect(out.id).toBe(upload.documentId);
      expect(typeof out.deletedAt).toBe('string');

      const [row] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.deletedAt).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on already-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-idempotent-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE' });
      const res = await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-delete';
      await db.insert(users).values({ id: otherUserId, email: 'od@p.t', displayName: 'OtherD' }).onConflictDoNothing();
      const docId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });

      const res = await app.request(`/api/documents/${docId}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/documents/:docId/restore', () => {
  it('clears deletedAt when called within 30 days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST' });
      expect(res.status).toBe(200);

      const [row] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.deletedAt).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 409 when deleted more than 30 days ago', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-expired-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await db
        .update(documents)
        .set({ deletedAt: thirtyOneDaysAgo })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('restore_window_expired');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on live doc (200, no change)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-live-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST' });
      expect(res.status).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-restore';
      await db.insert(users).values({ id: otherUserId, email: 'or@p.t', displayName: 'OtherR' }).onConflictDoNothing();
      const docId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
        deletedAt: new Date(),
      });

      const res = await app.request(`/api/documents/${docId}/restore`, { method: 'POST' });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test documents
```

- [ ] **Step 3: Implement DELETE and restore**

In `apps/api/src/routes/documents.ts`, add inside the route registration:

```ts
  app.delete('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existing] = await db
      .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    let deletedAt: Date;
    if (existing.deletedAt !== null) {
      deletedAt = existing.deletedAt;
    } else {
      deletedAt = new Date();
      await db.update(documents).set({ deletedAt }).where(eq(documents.id, docId));
    }

    return c.json({ id: docId, deletedAt: deletedAt.toISOString() }, 200);
  });

  app.post('/api/documents/:docId/restore', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existing] = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        createdAt: documents.createdAt,
        deletedAt: documents.deletedAt,
      })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    if (existing.deletedAt !== null) {
      const ageMs = Date.now() - existing.deletedAt.getTime();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      if (ageMs > THIRTY_DAYS_MS) {
        return c.json({ error: 'restore_window_expired', message: 'Restore window has expired.' }, 409);
      }
      await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, docId));
    }

    const [uploader] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, existing.uploaderId));

    return c.json(
      {
        id: existing.id,
        title: existing.title,
        description: existing.description,
        uploaderDisplayName: uploader?.displayName ?? '',
        createdAt: existing.createdAt.toISOString(),
      },
      200
    );
  });
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test documents
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): DELETE /api/documents/:docId (soft-delete) + POST /restore (30d window)"
git log --oneline -3
```

---

## Phase C — Versions API

### Task 5: POST `/api/documents/:docId/versions` (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/routes/documents.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { AddVersionResponse } from '@primer/shared';

function buildVersionFormData(html: string, versionNote?: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([html], { type: 'text/html' }), 'v2.html');
  if (versionNote !== undefined) fd.append('versionNote', versionNote);
  return fd;
}

describe('POST /api/documents/:docId/versions', () => {
  it('adds a new version with version_number incremented', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const fd = buildVersionFormData(
        '<html><body><h1>V2</h1></body></html>',
        'second version'
      );
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        body: fd,
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as AddVersionResponse;
      expect(out.versionNumber).toBe(2);
      expect(out.url).toBe(`/d/${upload.documentId}`);

      const allVersions = await db
        .select()
        .from(versions)
        .where(eq(versions.documentId, upload.documentId));
      expect(allVersions).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when doc is soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const fd = buildVersionFormData('<html><body></body></html>');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        body: fd,
      });
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-addver';
      await db.insert(users).values({ id: otherUserId, email: 'oa@p.t', displayName: 'OtherA' }).onConflictDoNothing();
      const docId = uuidv7();
      const versionId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: 1,
        storageKey: `v1/${versionId}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const fd = buildVersionFormData('<html><body></body></html>');
      const res = await app.request(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects too_large / bad_extension via the existing upload validators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-bad-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const big = 'x'.repeat(10 * 1024 * 1024 + 1);
      const fd = new FormData();
      fd.append('file', new Blob([big], { type: 'text/html' }), 'big.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        body: fd,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('too_large');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test documents
```

- [ ] **Step 3: Implement**

In `apps/api/src/routes/documents.ts`, add the route. The handler reuses `validateUpload` and `transformHtml` from the existing upload pipeline. Imports at the top:

```ts
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { sql } from 'drizzle-orm';
```

Then inside the route registration:

```ts
  app.post('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existingDoc] = await db
      .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existingDoc) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.deletedAt !== null) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    const form = await c.req.parseBody();
    const file = form['file'];
    const versionNoteRaw = form['versionNote'];

    let bytes: Uint8Array | undefined;
    let filename = '';
    let contentType: string | undefined;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      contentType = file.type === '' ? undefined : file.type;
    }

    const validated = validateUpload({
      file: bytes ? { filename, contentType, bytes } : undefined,
      title: 'placeholder-not-used',  // validateUpload requires non-empty title; we ignore the field
      description: undefined,
    });
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }

    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const transformed = transformHtml(text);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }

    let versionNote: string | null = null;
    if (typeof versionNoteRaw === 'string') {
      const trimmed = versionNoteRaw.trim();
      if (trimmed.length > 500) {
        return c.json({ error: 'invalid_body', message: 'versionNote must be ≤500 chars' }, 400);
      }
      versionNote = trimmed.length === 0 ? null : trimmed;
    }

    const versionId = uuidv7();
    const storageKey = `v1/${versionId}.html`;
    const transformedBytes = new TextEncoder().encode(transformed.html);

    // Find the next version_number atomically. The unique index on
    // (document_id, version_number) is the race backstop.
    const [maxRow] = (await db.execute(sql`
      SELECT COALESCE(MAX(version_number), 0)::int AS max_n
      FROM versions
      WHERE document_id = ${docId}
    `)) as unknown as { max_n: number }[];
    const nextNumber = (maxRow?.max_n ?? 0) + 1;

    // Storage put first, DB write second. If the DB write fails (e.g.,
    // race produces a 23505 from the unique index), compensating delete.
    await c.var; // ensure storage is available below
    const { storage } = (c as unknown as { var: { storage: import('@primer/shared').Storage } }).var ?? {};
    // Actually we get storage from the closure deps, not the request — fix:
    return await persistNewVersion(c, {
      docId,
      versionId,
      versionNumber: nextNumber,
      storageKey,
      sizeBytes: transformedBytes.byteLength,
      versionNote,
      transformedBytes,
    });
  });
```

That's not quite right — the storage isn't on `c.var`. Let me write the cleaner version: `registerDocumentRoutes` is called with `deps`, so we can use `deps.storage` directly inside the handler closure.

If `registerDocumentRoutes` currently accepts only `app` (without deps), update its signature to match the other route registrations:

```ts
export function registerDocumentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
```

And update the call site in `app.ts`. Then inside the new POST handler, use `deps.storage`:

```ts
    await deps.storage.put(storageKey, transformedBytes);

    try {
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: nextNumber,
        storageKey,
        sizeBytes: transformedBytes.byteLength,
        versionNote,
      });
    } catch (err) {
      // Race on the unique index → 23505. Best-effort cleanup of the storage file.
      try {
        await deps.storage.delete(storageKey);
      } catch {}
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return c.json({ error: 'version_race', message: 'Concurrent version write; retry.' }, 409);
      }
      throw err;
    }

    const response: AddVersionResponse = {
      versionId,
      versionNumber: nextNumber,
      url: `/d/${docId}`,
    };
    return c.json(response, 201);
```

So the final handler shape, written cleanly:

```ts
  app.post('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existingDoc] = await db
      .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existingDoc) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.deletedAt !== null) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    const form = await c.req.parseBody();
    const file = form['file'];
    const versionNoteRaw = form['versionNote'];

    let bytes: Uint8Array | undefined;
    let filename = '';
    let contentType: string | undefined;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      contentType = file.type === '' ? undefined : file.type;
    }

    const validated = validateUpload({
      file: bytes ? { filename, contentType, bytes } : undefined,
      title: 'unused-but-validator-needs-it',
      description: undefined,
    });
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }

    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const transformed = transformHtml(text);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }

    let versionNote: string | null = null;
    if (typeof versionNoteRaw === 'string') {
      const trimmed = versionNoteRaw.trim();
      if (trimmed.length > 500) {
        return c.json({ error: 'invalid_body', message: 'versionNote must be ≤500 chars' }, 400);
      }
      versionNote = trimmed.length === 0 ? null : trimmed;
    }

    const versionId = uuidv7();
    const storageKey = `v1/${versionId}.html`;
    const transformedBytes = new TextEncoder().encode(transformed.html);

    const [maxRow] = (await db.execute(sql`
      SELECT COALESCE(MAX(version_number), 0)::int AS max_n
      FROM versions
      WHERE document_id = ${docId}
    `)) as unknown as { max_n: number }[];
    const nextNumber = (maxRow?.max_n ?? 0) + 1;

    await deps.storage.put(storageKey, transformedBytes);

    try {
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: nextNumber,
        storageKey,
        sizeBytes: transformedBytes.byteLength,
        versionNote,
      });
    } catch (err) {
      try { await deps.storage.delete(storageKey); } catch {}
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return c.json({ error: 'version_race', message: 'Concurrent version write; retry.' }, 409);
      }
      throw err;
    }

    const response: AddVersionResponse = {
      versionId,
      versionNumber: nextNumber,
      url: `/d/${docId}`,
    };
    return c.json(response, 201);
  });
```

If `registerDocumentRoutes(app)` currently doesn't take deps, update both its signature and the call site in `apps/api/src/app.ts`:

Before:
```ts
registerDocumentRoutes(app);
```

After:
```ts
registerDocumentRoutes(app, deps);
```

- [ ] **Step 4: Add `AddVersionResponse` to imports**

```ts
import type { AddVersionResponse } from '@primer/shared';
```

- [ ] **Step 5: Run — verify pass**

```bash
pnpm --filter @primer/api test documents
pnpm --filter @primer/api typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): POST /api/documents/:docId/versions adds a new version"
git log --oneline -3
```

---

### Task 6: GET `/api/documents/:docId/versions` (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/routes/documents.test.ts`:

```ts
import type { VersionsListResponse } from '@primer/shared';

describe('GET /api/documents/:docId/versions', () => {
  it('returns all versions ordered by versionNumber DESC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-listver-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      // Add v2 + v3 via direct DB inserts so this test doesn't depend on
      // the POST endpoint.
      const v2Id = uuidv7();
      const v3Id = uuidv7();
      await db.insert(versions).values([
        {
          id: v2Id,
          documentId: upload.documentId,
          versionNumber: 2,
          storageKey: `v1/${v2Id}.html`,
          sizeBytes: 100,
          versionNote: 'second',
        },
        {
          id: v3Id,
          documentId: upload.documentId,
          versionNumber: 3,
          storageKey: `v1/${v3Id}.html`,
          sizeBytes: 200,
          versionNote: null,
        },
      ]);

      const res = await app.request(`/api/documents/${upload.documentId}/versions`);
      expect(res.status).toBe(200);
      const out = (await res.json()) as VersionsListResponse;
      expect(out.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      expect(out.versions[1].versionNote).toBe('second');
      expect(out.versions[0].versionNote).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when doc is soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-listver-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/versions`);
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test documents
```

- [ ] **Step 3: Implement**

Add to `apps/api/src/routes/documents.ts` (inside `registerDocumentRoutes`):

```ts
  app.get('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');

    const [existingDoc] = await db
      .select({ deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existingDoc) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

    const rows = await db
      .select({
        id: versions.id,
        versionNumber: versions.versionNumber,
        versionNote: versions.versionNote,
        sizeBytes: versions.sizeBytes,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(sql`${versions.versionNumber} DESC`);

    return c.json(
      {
        versions: rows.map((r) => ({
          id: r.id,
          versionNumber: r.versionNumber,
          versionNote: r.versionNote,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      200
    );
  });
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test documents
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): GET /api/documents/:docId/versions lists all versions"
```

---

### Task 7: PATCH `/api/versions/:vid` (TDD)

**Files:**
- Create: `apps/api/src/routes/versions.ts`
- Create: `apps/api/src/routes/versions.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/routes/versions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, users } from '@primer/shared/schema';
import type { VersionSummaryDTO } from '@primer/shared';

async function seedDocAndVersion(uploaderId: string = 'mock-user-1') {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed',
    description: null,
    uploaderId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: 'initial',
  });
  return { documentId, versionId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-versions-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('PATCH /api/versions/:vid', () => {
  it('updates version note when called by uploader of parent doc', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'fixed Y-axis scale' }),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as VersionSummaryDTO;
      expect(out.versionNote).toBe('fixed Y-axis scale');
    });
  });

  it('clears note when versionNote is null', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: null }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as VersionSummaryDTO).versionNote).toBeNull();
    });
  });

  it('normalizes empty string to null', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: '   ' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as VersionSummaryDTO).versionNote).toBeNull();
    });
  });

  it('returns 403 when caller is not the parent doc uploader', async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-vn';
      await db.insert(users).values({ id: otherUserId, email: 'ovn@p.t', displayName: 'OtherVN' }).onConflictDoNothing();
      const { versionId } = await seedDocAndVersion(otherUserId);

      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'sneaky' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('returns 404 when parent doc is soft-deleted', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocAndVersion();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));

      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'cant' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('returns 400 when note exceeds 500 chars', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'x'.repeat(501) }),
      });
      expect(res.status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test versions
```

Expected: 404 on all (route not registered yet).

- [ ] **Step 3: Implement**

File: `apps/api/src/routes/versions.ts`

```ts
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { VersionSummaryDTO } from '@primer/shared';
import { documents, versions } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export function registerVersionRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.patch('/api/versions/:versionId', async (c) => {
    const versionId = c.req.param('versionId');
    const user = c.get('user');

    let payload: { versionNote?: unknown };
    try {
      payload = (await c.req.json()) as { versionNote?: unknown };
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'versionNote')) {
      return c.json({ error: 'invalid_body', message: 'versionNote required (string or null)' }, 400);
    }

    let versionNote: string | null;
    if (payload.versionNote === null) {
      versionNote = null;
    } else if (typeof payload.versionNote === 'string') {
      const trimmed = payload.versionNote.trim();
      if (trimmed.length > 500) {
        return c.json({ error: 'invalid_body', message: 'versionNote must be ≤500 chars' }, 400);
      }
      versionNote = trimmed.length === 0 ? null : trimmed;
    } else {
      return c.json({ error: 'invalid_body', message: 'versionNote must be string or null' }, 400);
    }

    const [row] = await db
      .select({
        versionId: versions.id,
        documentId: versions.documentId,
        uploaderId: documents.uploaderId,
        docDeletedAt: documents.deletedAt,
      })
      .from(versions)
      .innerJoin(documents, eq(documents.id, versions.documentId))
      .where(eq(versions.id, versionId));
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.docDeletedAt !== null) return c.json({ error: 'not_found' }, 404);
    if (row.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    await db.update(versions).set({ versionNote }).where(eq(versions.id, versionId));

    const [updated] = await db
      .select({
        id: versions.id,
        versionNumber: versions.versionNumber,
        versionNote: versions.versionNote,
        sizeBytes: versions.sizeBytes,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(eq(versions.id, versionId));

    const dto: VersionSummaryDTO = {
      id: updated.id,
      versionNumber: updated.versionNumber,
      versionNote: updated.versionNote,
      sizeBytes: updated.sizeBytes,
      createdAt: updated.createdAt.toISOString(),
    };
    return c.json(dto, 200);
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

```ts
import { registerVersionRoutes } from './routes/versions.ts';

// inside createApp, after registerDashboardRoute(app):
registerVersionRoutes(app);
```

- [ ] **Step 5: Run — verify pass**

```bash
pnpm --filter @primer/api test versions
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): PATCH /api/versions/:vid edits version note (uploader-only)"
git log --oneline -3
```

---

## Phase D — Threads guard + dashboard

### Task 8: Threads endpoint 409 on non-latest version (TDD)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

- [ ] **Step 1: Failing test**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
describe('POST /api/versions/:vid/threads — non-latest guard', () => {
  it('returns 409 not_latest_version when posting to a non-latest version', async () => {
    await withApp(async (app) => {
      const { documentId, versionId: v1Id } = await seedDocument();

      // Insert a second version so v1 becomes non-latest.
      const v2Id = uuidv7();
      await db.insert(versions).values({
        id: v2Id,
        documentId,
        versionNumber: 2,
        storageKey: `v1/${v2Id}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const res = await app.request(`/api/versions/${v1Id}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'late comment',
        }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('not_latest_version');
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test threads
```

Expected: the new test fails (POST still 201 because there's no guard).

- [ ] **Step 3: Implement the guard**

In `apps/api/src/routes/threads.ts`, find the `app.post('/api/versions/:versionId/threads', ...)` handler. After the body and anchor validation, but BEFORE the transaction, add:

```ts
    // Reject posting to a non-latest version.
    const [latestRow] = (await db.execute(sql`
      SELECT MAX(version_number)::int AS max_n,
             (SELECT version_number FROM versions WHERE id = ${versionId}) AS this_n
      FROM versions
      WHERE document_id = (SELECT document_id FROM versions WHERE id = ${versionId})
    `)) as unknown as { max_n: number | null; this_n: number | null }[];

    if (!latestRow || latestRow.this_n === null) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (latestRow.this_n !== latestRow.max_n) {
      return c.json({ error: 'not_latest_version', message: 'Cannot post to a non-latest version.' }, 409);
    }
```

Ensure `sql` is imported in `threads.ts` (it already is — used by the ETag computation).

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test threads
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): threads endpoint returns 409 not_latest_version on old versions"
```

---

### Task 9: Dashboard adds `recentlyDeleted` (TDD)

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts`
- Modify: `apps/api/src/routes/dashboard.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/routes/dashboard.test.ts`:

```ts
describe('GET /api/dashboard — recentlyDeleted', () => {
  it('lists my soft-deleted docs within 30 days', async () => {
    await withApp(async (app) => {
      const d1 = await seedDoc('mock-user-1', 'Recently deleted A');
      await db.update(documents).set({ deletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) }).where(eq(documents.id, d1.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted).toHaveLength(1);
      expect(body.recentlyDeleted[0].id).toBe(d1.documentId);
      expect(body.recentlyDeleted[0].title).toBe('Recently deleted A');
      expect(body.recentlyDeleted[0].daysRemaining).toBeGreaterThan(20);
      expect(body.recentlyDeleted[0].daysRemaining).toBeLessThanOrEqual(25);
    });
  });

  it('excludes my soft-deleted docs older than 30 days', async () => {
    await withApp(async (app) => {
      const d1 = await seedDoc('mock-user-1', 'Old delete');
      await db.update(documents).set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }).where(eq(documents.id, d1.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted).toHaveLength(0);
    });
  });

  it("does not include other users' soft-deleted docs", async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-recently-deleted';
      await db.insert(users).values({ id: otherUserId, email: 'ord@p.t', displayName: 'OtherRD' }).onConflictDoNothing();
      const d = await seedDoc(otherUserId, 'Their delete');
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, d.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted.find((e) => e.id === d.documentId)).toBeUndefined();
    });
  });

  it("excludes soft-deleted docs from myDocuments", async () => {
    await withApp(async (app) => {
      const d = await seedDoc('mock-user-1', 'Soft deleted');
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, d.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.myDocuments.find((m) => m.id === d.documentId)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test dashboard
```

Expected: the recentlyDeleted assertions fail because the field doesn't exist on the response yet.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/dashboard.ts`, find the handler. After the existing my-docs and activity queries, add:

```ts
    // ── Recently deleted (uploader-only) ────────────────────────
    interface DeletedRow {
      id: string;
      title: string;
      deletedAt: string | Date;
    }
    const deletedRows = (await db.execute(sql`
      SELECT id, title, deleted_at AS "deletedAt"
      FROM documents
      WHERE uploader_id = ${userId}
        AND deleted_at IS NOT NULL
        AND deleted_at > now() - interval '30 days'
      ORDER BY deleted_at DESC
    `)) as unknown as DeletedRow[];
```

Then in the response object, add the new field:

```ts
    const recentlyDeleted = deletedRows.map((r) => {
      const deletedDate = r.deletedAt instanceof Date ? r.deletedAt : new Date(r.deletedAt);
      const ageDays = (Date.now() - deletedDate.getTime()) / (24 * 60 * 60 * 1000);
      const daysRemaining = Math.max(0, Math.min(30, Math.ceil(30 - ageDays)));
      return {
        id: r.id,
        title: r.title,
        deletedAt: deletedDate.toISOString(),
        daysRemaining,
      };
    });

    const body: DashboardResponse = { myDocuments, recentlyViewedOrCommented, recentlyDeleted };
    return c.json(body, 200);
```

Make sure `DashboardResponse` import already pulls the new shape from `@primer/shared`.

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test dashboard
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): dashboard adds recentlyDeleted (uploader-only, last 30 days)"
```

---

## Phase E — Purge job

### Task 10: `purgeExpiredDocuments` function (TDD)

**Files:**
- Create: `apps/api/src/jobs/purge.ts`
- Create: `apps/api/src/jobs/purge.test.ts`

- [ ] **Step 1: Failing tests**

File: `apps/api/src/jobs/purge.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { purgeExpiredDocuments } from './purge.ts';

async function seedExpiredDoc(daysOld: number, storage: FilesystemStorage) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Expired',
    description: null,
    uploaderId: 'mock-user-1',
    deletedAt: new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000),
  });
  const storageKey = `v1/${versionId}.html`;
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey,
    sizeBytes: 5,
    versionNote: null,
  });
  await storage.put(storageKey, new TextEncoder().encode('hello'));
  return { documentId, versionId, storageKey };
}

describe('purgeExpiredDocuments', () => {
  it('returns empty report when nothing is expired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-empty-'));
    try {
      const storage = new FilesystemStorage(root);
      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).toHaveLength(0);
      expect(report.purgedStorageKeys).toHaveLength(0);
      expect(report.failedStorageKeys).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes an expired doc and its storage file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-one-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId, storageKey } = await seedExpiredDoc(31, storage);

      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).toContain(documentId);
      expect(report.purgedStorageKeys).toContain(storageKey);
      expect(report.failedStorageKeys).toHaveLength(0);

      // DB rows gone.
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
      // Storage file gone.
      await expect(storage.get(storageKey)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not purge docs deleted within the 30-day window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-skip-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(29, storage);

      const report = await purgeExpiredDocuments({ storage });
      expect(report.purgedDocumentIds).not.toContain(documentId);

      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records failed storage deletes but still removes the DB row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-fail-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(31, storage);

      // Wrap storage.delete to fail for any v1/ key.
      const failingStorage = {
        ...storage,
        async put(key: string, bytes: Uint8Array) { return storage.put(key, bytes); },
        async get(key: string) { return storage.get(key); },
        async delete(key: string) {
          throw new Error('boom');
        },
      };

      const report = await purgeExpiredDocuments({ storage: failingStorage as unknown as FilesystemStorage });
      expect(report.failedStorageKeys.length).toBeGreaterThan(0);

      // DB row should still be gone (DB consistency wins per the design).
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on a clean DB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-purge-idem-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await seedExpiredDoc(31, storage);
      await purgeExpiredDocuments({ storage });
      const second = await purgeExpiredDocuments({ storage });
      expect(second.purgedDocumentIds).toHaveLength(0);
      const docRows = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test purge
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/jobs/purge.ts`

```ts
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import { logger } from '../logger.ts';
import type { Storage } from '@primer/shared';

export const RESTORE_WINDOW_DAYS = 30;

export interface PurgeReport {
  purgedDocumentIds: string[];
  purgedStorageKeys: string[];
  failedStorageKeys: { key: string; error: string }[];
  durationMs: number;
}

export async function purgeExpiredDocuments(deps: { storage: Storage }): Promise<PurgeReport> {
  const startedAt = Date.now();
  const report: PurgeReport = {
    purgedDocumentIds: [],
    purgedStorageKeys: [],
    failedStorageKeys: [],
    durationMs: 0,
  };

  const candidates = (await db.execute(sql`
    SELECT id FROM documents
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - interval '${sql.raw(String(RESTORE_WINDOW_DAYS))} days'
    ORDER BY deleted_at ASC
  `)) as unknown as { id: string }[];

  for (const { id: docId } of candidates) {
    const versionRows = await db
      .select({ id: versions.id, storageKey: versions.storageKey })
      .from(versions)
      .where(eq(versions.documentId, docId));

    // Delete storage files first.
    for (const v of versionRows) {
      try {
        await deps.storage.delete(v.storageKey);
        report.purgedStorageKeys.push(v.storageKey);
      } catch (err) {
        report.failedStorageKeys.push({
          key: v.storageKey,
          error: (err as Error).message,
        });
        logger.warn({ docId, storageKey: v.storageKey, err }, 'purge: storage delete failed');
      }
    }

    // Delete the doc row; FK cascade removes versions / threads / comments / document_views.
    await db.delete(documents).where(eq(documents.id, docId));
    report.purgedDocumentIds.push(docId);
    logger.info({ docId }, 'purge: document hard-deleted');
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test purge
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs
git commit -m "feat(api): purgeExpiredDocuments — hard-delete docs past 30-day window"
git log --oneline -3
```

---

### Task 11: Interval starter + CLI + wiring

**Files:**
- Modify: `apps/api/src/jobs/purge.ts`
- Create: `apps/api/src/jobs/purge-cli.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: root `package.json`

- [ ] **Step 1: Add `startPurgeInterval` to `purge.ts`**

Append to `apps/api/src/jobs/purge.ts`:

```ts
export function startPurgeInterval(deps: {
  storage: Storage;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const report = await purgeExpiredDocuments({ storage: deps.storage });
      if (report.purgedDocumentIds.length > 0 || report.failedStorageKeys.length > 0) {
        logger.info({ report }, 'purge interval: complete');
      }
    } catch (err) {
      logger.error({ err }, 'purge interval: unexpected failure');
    }
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [ ] **Step 2: Create the CLI script**

File: `apps/api/src/jobs/purge-cli.ts`

```ts
import '../env.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { purgeExpiredDocuments } from './purge.ts';
import { logger } from '../logger.ts';

const storage = new FilesystemStorage(process.env.STORAGE_ROOT ?? './storage');
const report = await purgeExpiredDocuments({ storage });
logger.info({ report }, 'purge-cli complete');
process.exit(report.failedStorageKeys.length > 0 ? 1 : 0);
```

- [ ] **Step 3: Wire interval into `index.ts`**

Modify `apps/api/src/index.ts`:

```ts
import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();
const app = createApp({ storage, notifier });

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot }, 'primer api listening');
});

const shutdown = () => {
  stopPurge();
  // Hono's @hono/node-server returns the underlying http.Server.
  if ('close' in server) {
    (server as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 4: Add `db:purge` script in `apps/api/package.json`**

In `apps/api/package.json`, add to `scripts`:

```json
"db:purge": "tsx src/jobs/purge-cli.ts"
```

- [ ] **Step 5: Add root passthrough script**

In root `package.json`, add to `scripts`:

```json
"db:purge": "pnpm --filter @primer/api run db:purge"
```

- [ ] **Step 6: Run tests + typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: full suite still green; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs apps/api/src/index.ts apps/api/package.json package.json
git commit -m "feat(api): purge interval starter + pnpm db:purge CLI"
```

---

## Phase F — Frontend shared components

### Task 12: `FileDropZone` component

**Files:**
- Create: `apps/web/src/components/FileDropZone.tsx`

- [ ] **Step 1: Create the component**

File: `apps/web/src/components/FileDropZone.tsx`

```tsx
import { useEffect, useRef, useState, type DragEvent } from 'react';

interface Props {
  file: File | null;
  onChange: (file: File | null) => void;
  /** Max bytes; default 10 MiB */
  maxBytes?: number;
  /** Disabled state */
  disabled?: boolean;
}

const TEN_MIB = 10 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validate(file: File, maxBytes: number): string | null {
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.html')) return 'Only .html files are accepted.';
  if (file.size > maxBytes) {
    return `This file is ${formatSize(file.size)} — limit is ${formatSize(maxBytes)}.`;
  }
  return null;
}

export function FileDropZone({ file, onChange, maxBytes = TEN_MIB, disabled = false }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      setError(null);
      return;
    }
    setError(validate(file, maxBytes));
  }, [file, maxBytes]);

  function handlePick(f: File | null) {
    if (disabled) return;
    if (!f) {
      onChange(null);
      return;
    }
    const v = validate(f, maxBytes);
    setError(v);
    onChange(v ? null : f);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0] ?? null;
    handlePick(f);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (disabled) return;
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function openPicker() {
    if (disabled) return;
    inputRef.current?.click();
  }

  const borderClass = error
    ? 'border-red-400 bg-red-50'
    : isDragging
      ? 'border-yellow-500 bg-yellow-50'
      : 'border-neutral-300 bg-neutral-50';

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Upload HTML file"
        aria-invalid={error !== null}
        aria-describedby={error ? 'filedropzone-error' : undefined}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`flex h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${borderClass} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {!file ? (
          <>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mb-2 text-neutral-500" aria-hidden="true">
              <path d="M12 5v14M5 12l7-7 7 7" />
            </svg>
            <p className="text-sm font-medium text-neutral-700">
              {isDragging ? 'Drop to attach' : 'Drop an HTML file here, or click to browse'}
            </p>
            <p className="mt-1 text-xs text-neutral-500">.html files up to {formatSize(maxBytes)}</p>
          </>
        ) : (
          <div className="flex w-full items-center gap-3 px-4">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-neutral-600" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral-800">{file.name}</div>
              <div className="text-xs text-neutral-500">{formatSize(file.size)}</div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openPicker();
              }}
              className="text-xs font-medium text-neutral-600 underline hover:text-neutral-900"
            >
              Replace
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".html,text/html"
          className="hidden"
          onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
        />
      </div>
      {error && (
        <p id="filedropzone-error" role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
      <div aria-live="polite" className="sr-only">
        {isDragging ? 'Drop to attach the file.' : ''}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/taylan/development/polygon/primer
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
pnpm --filter @primer/web typecheck
git add apps/web/src/components/FileDropZone.tsx
git commit -m "feat(web): FileDropZone with drag-and-drop, inline validation, accessibility"
git log --oneline -3
```

---

### Task 13: `EditableField` component

**Files:**
- Create: `apps/web/src/components/EditableField.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/EditableField.tsx`

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  value: string | null;
  placeholder: string;
  /** Whether the current user is allowed to edit. */
  canEdit: boolean;
  /** Render mode: single-line input vs. multi-line textarea. */
  multiline?: boolean;
  /** Tailwind classes for the display element. */
  displayClassName?: string;
  /** Max chars (applied to maxlength attribute and not enforced post-trim). */
  maxLength?: number;
  /** Saved when the user commits via Enter (input) / Cmd+Enter (textarea) / blur. */
  onSave: (next: string | null) => Promise<void> | void;
  /** Aria label for screen readers. */
  ariaLabel: string;
}

export function EditableField({
  value,
  placeholder,
  canEdit,
  multiline = false,
  displayClassName = '',
  maxLength,
  onSave,
  ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  async function commit() {
    const trimmed = draft.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if (next === (value ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(value ?? '');
    setError(null);
    setEditing(false);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter') {
      if (multiline && !(e.metaKey || e.ctrlKey)) return; // multiline: only Cmd/Ctrl+Enter saves
      e.preventDefault();
      void commit();
    }
  }

  if (!editing) {
    const isEmpty = !value || value.length === 0;
    return (
      <div
        className={`group inline-flex items-center gap-1.5 ${canEdit ? 'cursor-pointer' : ''}`}
        onClick={() => canEdit && setEditing(true)}
      >
        <span className={`${displayClassName} ${isEmpty && canEdit ? 'italic text-neutral-400' : ''}`}>
          {isEmpty ? (canEdit ? placeholder : '') : value}
        </span>
        {canEdit && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="opacity-0 transition-opacity group-hover:opacity-60"
            aria-hidden="true"
          >
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        )}
      </div>
    );
  }

  const Input = multiline ? 'textarea' : 'input';

  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={inputRef as React.Ref<HTMLInputElement & HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={handleKey}
        onBlur={() => { void commit(); }}
        maxLength={maxLength}
        aria-label={ariaLabel}
        rows={multiline ? 3 : undefined}
        className={`block w-full rounded border border-neutral-300 px-2 py-1 text-sm ${displayClassName}`}
        disabled={saving}
      />
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
git add apps/web/src/components/EditableField.tsx
git commit -m "feat(web): EditableField for inline title/desc/version-note editing"
```

---

### Task 14: `VersionSelector` component

**Files:**
- Create: `apps/web/src/components/VersionSelector.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/VersionSelector.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VersionSummaryDTO } from '@primer/shared';

interface Props {
  docId: string;
  versions: VersionSummaryDTO[];
  currentVersionNumber: number;
  isViewingLatest: boolean;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function VersionSelector({
  docId,
  versions,
  currentVersionNumber,
  isViewingLatest,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const latest = versions[0];
  const latestNumber = latest?.versionNumber ?? currentVersionNumber;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = isViewingLatest
    ? `v${currentVersionNumber} · latest`
    : `v${currentVersionNumber} of ${latestNumber}`;

  function pick(v: VersionSummaryDTO) {
    setOpen(false);
    if (v.versionNumber === latestNumber) {
      navigate(`/d/${docId}`);
    } else {
      navigate(`/d/${docId}/v/${v.versionNumber}`);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded border border-neutral-200 bg-white shadow-md"
        >
          {versions.map((v) => {
            const isCurrent = v.versionNumber === currentVersionNumber;
            const isLatest = v.versionNumber === latestNumber;
            return (
              <li
                key={v.id}
                role="option"
                aria-selected={isCurrent}
                onClick={() => pick(v)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-neutral-50 ${isCurrent ? 'bg-yellow-50' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-neutral-700">v{v.versionNumber}</div>
                  <div className="truncate text-neutral-500">
                    {v.versionNote ? v.versionNote : <span className="italic text-neutral-400">no note</span>}
                  </div>
                  <div className="text-[10px] text-neutral-400">{relativeTime(v.createdAt)}</div>
                </div>
                {isLatest && (
                  <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
                    Latest
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
git add apps/web/src/components/VersionSelector.tsx
git commit -m "feat(web): VersionSelector dropdown"
```

---

## Phase G — Frontend queries

### Task 15: Versions queries + document mutations

**Files:**
- Create: `apps/web/src/queries/versions.ts`
- Modify: `apps/web/src/queries/documents.ts`

- [ ] **Step 1: Create the versions hook file**

File: `apps/web/src/queries/versions.ts`

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddVersionResponse,
  VersionPatchRequest,
  VersionSummaryDTO,
  VersionsListResponse,
} from '@primer/shared';

export function useVersionsQuery(docId: string) {
  return useQuery({
    queryKey: ['versions', docId],
    queryFn: async ({ signal }): Promise<VersionsListResponse> => {
      const res = await fetch(`/api/documents/${docId}/versions`, { signal });
      if (!res.ok) throw new Error(`versions fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: docId.length > 0,
    staleTime: 30_000,
  });
}

export function useAddVersion(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; versionNote: string | null }): Promise<AddVersionResponse> => {
      const fd = new FormData();
      fd.append('file', input.file);
      if (input.versionNote !== null) fd.append('versionNote', input.versionNote);
      const res = await fetch(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`add version failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', docId] });
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useEditVersionNote(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (versionNote: string | null): Promise<VersionSummaryDTO> => {
      const payload: VersionPatchRequest = { versionNote };
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`edit version note failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      // We don't know the docId here; invalidate all versions queries.
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
  });
}
```

- [ ] **Step 2: Add document mutations**

Modify `apps/web/src/queries/documents.ts`. Keep the existing `useDocument` hook and append:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DocumentPatchRequest } from '@primer/shared';

export function useEditDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DocumentPatchRequest) => {
      const res = await fetch(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`edit doc failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ id: string; deletedAt: string }> => {
      const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useRestoreDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/documents/${docId}/restore`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`restore failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
git add apps/web/src/queries
git commit -m "feat(web): versions queries + document mutation hooks"
git log --oneline -3
```

---

## Phase H — Upload page polish

### Task 16: `UploadPage` uses `FileDropZone`

**Files:**
- Modify: `apps/web/src/routes/upload.tsx`

- [ ] **Step 1: Rewrite the form**

Replace the contents of `apps/web/src/routes/upload.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UploadErrorResponse, UploadResponse } from '@primer/shared';
import { FileDropZone } from '../components/FileDropZone.tsx';

export function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Please choose an .html file.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      if (description) fd.append('description', description);

      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<UploadErrorResponse>;
        setError(body.message ?? `Upload failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as UploadResponse;
      navigate(body.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = file !== null && title.trim().length > 0 && !submitting;

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold">Upload a document</h1>

      <FileDropZone file={file} onChange={setFile} />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Title *</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck + build + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
git add apps/web/src/routes/upload.tsx
git commit -m "feat(web): UploadPage uses FileDropZone, polished layout"
git log --oneline -3
```

---

## Phase I — Add-version modal

### Task 17: `AddVersionModal` + wire into Home + Document headers

**Files:**
- Create: `apps/web/src/components/AddVersionModal.tsx`

- [ ] **Step 1: Implement the modal**

File: `apps/web/src/components/AddVersionModal.tsx`

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DashboardDocumentSummary } from '@primer/shared';
import { useDashboardQuery } from '../queries/dashboard.ts';
import { useAddVersion } from '../queries/versions.ts';
import { FileDropZone } from './FileDropZone.tsx';

interface Props {
  open: boolean;
  /** If provided, the doc combobox is pre-filled and the user can swap via the change-doc link. */
  preselectedDocId?: string;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function AddVersionModal({ open, preselectedDocId, onClose }: Props) {
  const navigate = useNavigate();
  const dashboard = useDashboardQuery();
  const myDocs = dashboard.data?.myDocuments ?? [];

  const [selectedDocId, setSelectedDocId] = useState<string | undefined>(preselectedDocId);
  const [file, setFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerSelector = useRef<HTMLElement | null>(null);

  const addVersion = useAddVersion(selectedDocId ?? '');

  // Reset state when the modal opens or the preselected doc changes.
  useEffect(() => {
    if (open) {
      triggerSelector.current = document.activeElement as HTMLElement | null;
      setSelectedDocId(preselectedDocId);
      setFile(null);
      setVersionNote('');
      setQuery('');
      setError(null);
    } else {
      triggerSelector.current?.focus();
    }
  }, [open, preselectedDocId]);

  // ESC + focus trap (light version).
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

  const filteredDocs = useMemo(() => {
    if (!query) return myDocs.slice(0, 8);
    const lower = query.toLowerCase();
    return myDocs.filter((d) => d.title.toLowerCase().includes(lower)).slice(0, 8);
  }, [myDocs, query]);

  const selectedDoc: DashboardDocumentSummary | undefined = useMemo(
    () => myDocs.find((d) => d.id === selectedDocId),
    [myDocs, selectedDocId]
  );

  if (!open) return null;

  const canSubmit = !!selectedDocId && !!file && !addVersion.isPending;

  async function submit() {
    if (!selectedDocId || !file) return;
    setError(null);
    try {
      const trimmed = versionNote.trim();
      await addVersion.mutateAsync({ file, versionNote: trimmed.length === 0 ? null : trimmed });
      onClose();
      navigate(`/d/${selectedDocId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

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
        aria-labelledby="add-version-title"
        className="w-full max-w-[520px] rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <h2 id="add-version-title" className="text-base font-semibold text-neutral-900">
            Add a new version
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-900"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-700">Document</label>
            {preselectedDocId && selectedDocId === preselectedDocId ? (
              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                <div className="font-medium text-neutral-800">
                  {selectedDoc?.title ?? '(loading)'}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDocId(undefined)}
                  className="mt-1 text-xs text-neutral-500 underline hover:text-neutral-900"
                >
                  ← change document
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your documents…"
                  className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                />
                {filteredDocs.length > 0 && (
                  <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border border-neutral-200">
                    {filteredDocs.map((d) => (
                      <li
                        key={d.id}
                        onClick={() => {
                          setSelectedDocId(d.id);
                          setQuery(d.title);
                        }}
                        className={`cursor-pointer px-3 py-2 text-sm hover:bg-neutral-50 ${
                          d.id === selectedDocId ? 'bg-yellow-50' : ''
                        }`}
                      >
                        <div className="font-medium text-neutral-800">{d.title}</div>
                        <div className="text-xs text-neutral-500">
                          {d.activeThreadCount}/{d.threadCount} active · {relativeTime(d.lastActivityAt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {selectedDoc && (
              <div className="mt-1 text-xs text-neutral-500">
                Last updated {relativeTime(selectedDoc.lastActivityAt)}
              </div>
            )}
          </div>

          <FileDropZone file={file} onChange={setFile} />

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700">
              Version note (optional)
            </span>
            <input
              type="text"
              value={versionNote}
              onChange={(e) => setVersionNote(e.target.value)}
              maxLength={500}
              placeholder='e.g. "fixed Y-axis scale"'
              className="block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 bg-white px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {addVersion.isPending ? 'Adding…' : 'Add version'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
git add apps/web/src/components/AddVersionModal.tsx
git commit -m "feat(web): AddVersionModal with combobox + FileDropZone + version note"
git log --oneline -3
```

---

## Phase J — DocumentPage rewrite (split into two)

### Task 18: DocumentPage — VersionSelector + routing + read-mostly mode

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Register the versioned route**

In `apps/web/src/App.tsx`, find the existing routes array and add:

```tsx
{ path: '/d/:docId/v/:versionNumber', element: <DocumentPage /> },
```

Place it alongside the existing `{ path: '/d/:docId', element: <DocumentPage /> }`.

- [ ] **Step 2: Extend `DocumentPage` with version routing + selector + read-mostly**

Open `apps/web/src/routes/document.tsx`. The new behavior:

- Read `:versionNumber` from `useParams` (optional).
- Always call `useVersionsQuery(docId)` to resolve the list (even on `/d/:docId`, so the selector has data).
- When `versionNumber` is in the URL, resolve to a `versionId`; render in read-mostly mode if it's not the latest.
- When `versionNumber` is absent, use the existing `useDocument(docId)` `latestVersion`.

Replace the file with:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type {
  AnchorData,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
} from '@primer/shared';
import { useDocument } from '../queries/documents.ts';
import { useVersionsQuery } from '../queries/versions.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { VersionSelector } from '../components/VersionSelector.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

const MOCK_USER_ID = 'mock-user-1';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

export function DocumentPage() {
  const { docId, versionNumber: versionNumberParam } = useParams();
  const navigate = useNavigate();
  const docQuery = useDocument(docId ?? '');
  const versionsQuery = useVersionsQuery(docId ?? '');
  const versions = versionsQuery.data?.versions ?? [];

  const requestedNumber = versionNumberParam ? Number(versionNumberParam) : undefined;
  const latestVersion = versions[0];
  const latestNumber = latestVersion?.versionNumber;

  const pinnedVersion = useMemo(() => {
    if (requestedNumber === undefined) return undefined;
    return versions.find((v) => v.versionNumber === requestedNumber);
  }, [versions, requestedNumber]);

  // The version we're actually viewing: pinned if requested+found, else latest.
  const currentVersion = pinnedVersion ?? latestVersion;
  const currentVersionId = currentVersion?.id ?? '';
  const currentVersionNumber = currentVersion?.versionNumber ?? 1;
  const isViewingLatest =
    !requestedNumber || (latestNumber !== undefined && requestedNumber === latestNumber);
  const readMostly = !isViewingLatest;

  // Handle "version not found" — requested a number that doesn't exist.
  const versionNotFound =
    requestedNumber !== undefined && versionsQuery.isSuccess && !pinnedVersion;

  const threadsQuery = useThreadsQuery(currentVersionId);
  const threads = threadsQuery.data?.data.threads ?? [];
  const createThread = useCreateThread(currentVersionId);

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [positionsByAnchorId, setPositionsByAnchorId] = useState<
    Map<string, { y: number; drifted: boolean }>
  >(new Map());

  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);

  const anchorsForCompanion = useMemo(
    () => threads.map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const registerSender = useCallback(
    (s: ((m: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
      if (s) {
        s({ type: 'update_anchors', anchors: anchorsForCompanion });
        s({ type: 'request_anchor_positions' });
      }
    },
    [anchorsForCompanion]
  );

  useEffect(() => {
    const s = senderRef.current;
    if (!s) return;
    s({ type: 'update_anchors', anchors: anchorsForCompanion });
    s({ type: 'request_anchor_positions' });
  }, [anchorsForCompanion]);

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      switch (msg.type) {
        case 'selection_captured':
          if (!readMostly) {
            setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
            setPendingPick(null);
          }
          break;
        case 'element_picked':
          if (!readMostly) {
            setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
            setPendingSelection(null);
            setPickMode(false);
          }
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'anchor_positions':
          setPositionsByAnchorId(
            new Map(
              msg.positions.map((p) => [
                p.anchorId,
                {
                  y: p.rects[0]?.y ?? Number.POSITIVE_INFINITY,
                  drifted: p.drifted ?? false,
                },
              ])
            )
          );
          break;
        case 'open_external':
          if (isSafeExternalUrl(msg.url)) handleOpenExternal(msg);
          break;
        case 'resize':
          senderRef.current?.({ type: 'request_anchor_positions' });
          break;
      }
    },
    [readMostly]
  );

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  const onHighlight = useCallback((anchorId: string) => {
    senderRef.current?.({ type: 'highlight_anchor', anchorId });
  }, []);

  const submitPending = async (body: string) => {
    const anchor: AnchorData | null = pendingSelection
      ? pendingSelection.anchor
      : pendingPick
      ? pendingPick.anchor
      : null;
    if (!anchor) return;
    await createThread.mutateAsync({ anchor, body });
    setPendingSelection(null);
    setPendingPick(null);
  };

  if (docQuery.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (docQuery.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(docQuery.error as Error).message}
      </div>
    );
  }
  if (!docQuery.data) return null;

  if (versionNotFound) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Version not found</h1>
        <p className="text-sm text-neutral-600">
          Version {requestedNumber} doesn't exist for this document.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/d/${docId}`)}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
        >
          Back to latest
        </button>
      </div>
    );
  }

  const { document } = docQuery.data;
  const composerPending = readMostly
    ? null
    : pendingSelection
      ? { anchor: pendingSelection.anchor as AnchorData }
      : pendingPick
        ? { anchor: pendingPick.anchor as AnchorData }
        : null;

  let pillPos: { left: number; top: number } | null = null;
  if (!readMostly && pendingSelection && pendingSelection.clientRects.length > 0) {
    const iframeEl = iframeWrapperRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const r = pendingSelection.clientRects[0];
    pillPos = {
      left: (iframeRect?.left ?? 0) + r.x,
      top: (iframeRect?.top ?? 0) + r.y + r.height + 4,
    };
  }

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-4 pb-2 pt-1">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {versions.length > 0 && (
            <VersionSelector
              docId={docId!}
              versions={versions}
              currentVersionNumber={currentVersionNumber}
              isViewingLatest={isViewingLatest}
            />
          )}
          {!readMostly && (
            <button
              onClick={togglePickMode}
              className={`rounded px-3 py-1 text-sm ${
                pickMode
                  ? 'bg-red-600 text-white'
                  : 'border border-neutral-300 hover:bg-neutral-100'
              }`}
            >
              {pickMode ? 'Exit pick mode' : 'Pick element'}
            </button>
          )}
          <div className="text-sm text-neutral-500">
            {document.uploaderDisplayName} ·{' '}
            {new Date(document.createdAt).toLocaleString()}
          </div>
        </div>
      </header>

      {readMostly && (
        <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-amber-900">
          <span>
            You're viewing v{currentVersionNumber} of "{document.title}". This version is
            read-only. Switch to v{latestNumber} (latest) to add new comments.
          </span>
          <button
            type="button"
            onClick={() => navigate(`/d/${docId}`)}
            className="rounded border border-amber-700 px-2 py-0.5 text-amber-900 hover:bg-amber-100"
          >
            Switch to latest
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        <CommentSidebar
          versionId={currentVersionId}
          currentUserId={MOCK_USER_ID}
          pending={composerPending}
          onCancelPending={() => {
            setPendingSelection(null);
            setPendingPick(null);
          }}
          onSubmitPending={submitPending}
          onHighlight={onHighlight}
          positionsByAnchorId={positionsByAnchorId}
        />
      </div>

      {pillPos && pendingSelection && composerPending && (
        <div
          style={{ position: 'fixed', left: pillPos.left, top: pillPos.top, zIndex: 1000 }}
          className="flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <span>Add comment in sidebar →</span>
          <button
            type="button"
            onClick={() => setPendingSelection(null)}
            className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
git add apps/web/src
git commit -m "feat(web): DocumentPage adds VersionSelector + versioned route + read-mostly mode"
git log --oneline -3
```

---

### Task 19: DocumentPage — inline editing + action buttons + confirm popover

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Add inline editing of title/description, +Version button, delete menu, AddVersionModal trigger**

Open `apps/web/src/routes/document.tsx`. Add imports at the top:

```tsx
import { EditableField } from '../components/EditableField.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
import { useDeleteDocument, useEditDocument } from '../queries/documents.ts';
```

Inside the component, after the existing hooks, add:

```tsx
  const editDoc = useEditDocument(docId ?? '');
  const deleteDoc = useDeleteDocument(docId ?? '');

  const [showAddVersion, setShowAddVersion] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isUploader = docQuery.data?.document.uploaderDisplayName === 'Mock User';
  // In SP4 with the single mock user, every uploader check is effectively "is this the
  // mock user". SP5 will swap this for `docQuery.data?.document.uploaderId === user.id`
  // when the doc DTO exposes uploaderId.
```

Replace the existing title/description `<h1>`/`<p>` block in the header with `EditableField` instances:

```tsx
        <div>
          <EditableField
            value={document.title}
            placeholder="Add a title"
            canEdit={isUploader}
            displayClassName="text-xl font-semibold"
            maxLength={200}
            ariaLabel="Document title"
            onSave={async (next) => {
              if (next === null || next.trim().length === 0) {
                throw new Error('Title cannot be empty');
              }
              await editDoc.mutateAsync({ title: next });
            }}
          />
          <EditableField
            value={document.description}
            placeholder="Add a description"
            canEdit={isUploader}
            multiline
            displayClassName="text-sm text-neutral-600"
            maxLength={2000}
            ariaLabel="Document description"
            onSave={async (next) => {
              await editDoc.mutateAsync({ description: next });
            }}
          />
        </div>
```

In the right-side action area of the header, after the existing pick mode button, add the `+ Version` button and the `⋯` menu (uploader-only):

```tsx
          {isUploader && !readMostly && (
            <button
              type="button"
              onClick={() => setShowAddVersion(true)}
              className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              + Version
            </button>
          )}
          {isUploader && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm((s) => !s)}
                aria-label="More actions"
                className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                ⋯
              </button>
              {showDeleteConfirm && (
                <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md">
                  <p className="text-xs text-neutral-700">
                    Delete this document? You can restore it within 30 days from the home page.
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(false)}
                      className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteDoc.mutateAsync();
                        setShowDeleteConfirm(false);
                        navigate('/');
                      }}
                      className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
```

At the very end of the render, before the closing `</div>` of the outermost wrapper, add the modal mount:

```tsx
      <AddVersionModal
        open={showAddVersion}
        preselectedDocId={docId}
        onClose={() => setShowAddVersion(false)}
      />
```

- [ ] **Step 2: Typecheck + build + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): DocumentPage inline title/desc editing + Version/Delete actions"
git log --oneline -3
```

---

## Phase K — HomePage updates

### Task 20: HomePage — Recently deleted section + Add new version entry; DocumentListRow updates

**Files:**
- Modify: `apps/web/src/components/DocumentListRow.tsx`
- Modify: `apps/web/src/routes/home.tsx`

- [ ] **Step 1: Add `DeletedDocumentRow` to `DocumentListRow.tsx`**

Append to `apps/web/src/components/DocumentListRow.tsx`:

```tsx
import type { DeletedDocumentEntry } from '@primer/shared';
import { useRestoreDocument } from '../queries/documents.ts';

interface DeletedRowProps {
  entry: DeletedDocumentEntry;
}

export function DeletedDocumentRow({ entry }: DeletedRowProps) {
  const restore = useRestoreDocument(entry.id);
  const isUrgent = entry.daysRemaining <= 3;

  return (
    <div className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-800 truncate">{entry.title}</span>
        <span className="text-xs text-neutral-500">
          Deleted {new Date(entry.deletedAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            isUrgent ? 'bg-red-100 text-red-700' : 'bg-neutral-100 text-neutral-600'
          }`}
        >
          {entry.daysRemaining} {entry.daysRemaining === 1 ? 'day' : 'days'} left
        </span>
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() => restore.mutate()}
          className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `home.tsx` with the new sections**

Replace the contents of `apps/web/src/routes/home.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDashboardQuery } from '../queries/dashboard.ts';
import {
  ActivityRow,
  DeletedDocumentRow,
  MyDocumentRow,
} from '../components/DocumentListRow.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';

export function HomePage() {
  const q = useDashboardQuery();
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  return (
    <div className="space-y-8 max-w-3xl">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddVersion(true)}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            + Add new version
          </button>
          <Link
            to="/upload"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
          >
            + Upload document
          </Link>
        </div>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && (
        <div className="text-sm text-red-600">
          Could not load dashboard: {(q.error as Error).message}
        </div>
      )}

      {q.data && (
        <>
          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                My documents
              </h2>
              <span className="text-xs text-neutral-500">
                {q.data.myDocuments.length}{' '}
                {q.data.myDocuments.length === 1 ? 'doc' : 'docs'}
              </span>
            </div>
            {q.data.myDocuments.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">
                No documents yet. Upload your first one.
              </div>
            ) : (
              q.data.myDocuments.map((doc) => <MyDocumentRow key={doc.id} doc={doc} />)
            )}
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                Recently viewed or commented
              </h2>
              <span className="text-xs text-neutral-500">Last 30 days</span>
            </div>
            {q.data.recentlyViewedOrCommented.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">Nothing recent.</div>
            ) : (
              q.data.recentlyViewedOrCommented.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </section>

          <section>
            <button
              type="button"
              onClick={() => setShowDeleted((s) => !s)}
              className="flex w-full items-baseline justify-between border-b border-neutral-200 pb-1 text-left"
              aria-expanded={showDeleted}
            >
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                Recently deleted
              </h2>
              <span className="text-xs text-neutral-500">
                {q.data.recentlyDeleted.length === 0
                  ? showDeleted
                    ? 'none'
                    : '—'
                  : `${q.data.recentlyDeleted.length}`}{' '}
                {showDeleted ? '▾' : '▸'}
              </span>
            </button>
            {showDeleted && (
              <>
                {q.data.recentlyDeleted.length === 0 ? (
                  <div className="px-1 py-4 text-sm italic text-neutral-500">
                    No deleted documents.
                  </div>
                ) : (
                  q.data.recentlyDeleted.map((entry) => (
                    <DeletedDocumentRow key={entry.id} entry={entry} />
                  ))
                )}
              </>
            )}
          </section>
        </>
      )}

      <AddVersionModal open={showAddVersion} onClose={() => setShowAddVersion(false)} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
git add apps/web/src
git commit -m "feat(web): HomePage Recently deleted + Add new version entry"
git log --oneline -3
```

---

## Phase L — Verification + finalize

### Task 21: Cross-cutting verification

**Files:** none.

- [ ] **Step 1: `pnpm verify` + smoke**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm verify 2>&1 | tail -30
```

Expected: typecheck clean, tests green (api ~85ish + web 17). Audit at high level clean.

- [ ] **Step 2: Boot smoke check**

```bash
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1

pnpm dev > /tmp/primer-sp4-smoke.log 2>&1 &
DEV_PID=$!
sleep 6
curl -s http://localhost:3000/api/health
echo
curl -s http://localhost:3000/api/dashboard | head -c 200
echo
kill $DEV_PID 2>/dev/null
wait 2>/dev/null
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
```

Expected: `/api/health` → `{"ok":true}`. `/api/dashboard` returns `{...recentlyDeleted: [...]}`.

- [ ] **Step 3: Commit history check**

```bash
git log --oneline master..HEAD | wc -l
git log --oneline -25
```

- [ ] **Step 4: Apply small fixes if anything failed; otherwise nothing**

Don't merge here — the squash merge is Task 22.

---

### Task 22: Final code review + squash merge

**Files:** none beyond branch deletion.

- [ ] **Step 1: Dispatch a final code reviewer** for the entire `master..feat/versioning-soft-delete` diff. Focus areas:
  - Authorization correctness on every uploader-only endpoint (PATCH/DELETE/restore/add-version/list-versions/version-patch).
  - Soft-delete visibility (404 on GET, 404 on threads, list-versions also 404).
  - Add-version race protection via the 23505 catch.
  - Purge job correctness (storage-first then DB; partial-failure → DB still consistent).
  - DocumentPage rewrite — anchor sync still works, position-tracking still re-sorts the sidebar, read-mostly hides composer + pick mode + +Version button entirely.

- [ ] **Step 2: Apply small fixes** flagged as Important. Skip Minor.

- [ ] **Step 3: Squash-merge**

```bash
cd /home/taylan/development/polygon/primer
git checkout master
git merge --squash feat/versioning-soft-delete
git commit -m "$(cat <<'EOF'
Implement Primer sub-project 4: versioning + soft-delete

Closes Phase 1 by adding the artifact lifecycle:

API:
- Soft-delete visibility (404 on GET / threads / list-versions / version-
  content / version-patch when documents.deletedAt is set).
- PATCH /api/documents/:docId — uploader edits title/description.
- DELETE /api/documents/:docId — soft-delete (idempotent).
- POST /api/documents/:docId/restore — clear deletedAt within 30 days;
  409 restore_window_expired past 30d (idempotent on live doc).
- POST /api/documents/:docId/versions — multipart add-version; reuses the
  upload pipeline (validate + parse5 + sanitize + companion inject);
  monotonic version_number incremented atomically with 23505 race catch
  returning 409 version_race.
- GET /api/documents/:docId/versions — list versions ordered by
  versionNumber DESC; used by the selector and to resolve
  versionNumber → versionId on /d/:docId/v/:N.
- PATCH /api/versions/:vid — edit version note (uploader-only, ≤500
  chars, null clears, empty string normalized to null).
- POST /api/versions/:vid/threads — adds guard returning 409
  not_latest_version when the target isn't the doc's latest.
- GET /api/dashboard — adds recentlyDeleted list (uploader's
  soft-deleted docs within 30d, with daysRemaining).

Purge job:
- purgeExpiredDocuments({ storage }) — hard-deletes documents with
  deletedAt > 30d old; storage files deleted first (compensating
  pattern), then DB row (FK cascade removes versions/threads/comments/
  document_views). Failed storage deletes recorded but don't block DB
  consistency.
- startPurgeInterval — default 1h, configurable via PURGE_INTERVAL_MS.
- pnpm db:purge CLI for explicit invocations.

Web:
- New components: FileDropZone (drag-and-drop with inline validation),
  EditableField (click-to-edit for title/desc/version-note, Cmd/Ctrl+
  Enter saves, Esc cancels), VersionSelector (dropdown with version
  number + note + relative time), AddVersionModal (combobox + dropzone
  + version note), RestoreButton (in DeletedDocumentRow).
- UploadPage rewritten with FileDropZone + polished layout (file first,
  then title/description).
- DocumentPage extended: VersionSelector, read-mostly banner + composer/
  pick-mode/Version-button suppression on old versions, /d/:docId/v/:N
  routing, inline title/description editing (EditableField), + Version
  button (uploader-only), ⋯ menu with Delete + inline confirm popover.
- HomePage adds collapsed Recently deleted section with per-row
  Restore button (red badge when ≤3 days remaining), and a +Add new
  version chrome entry that opens the modal with an empty combobox.

Tests: ~13 new api test cases covering every endpoint + the purge job
+ dashboard recentlyDeleted scenarios.

No new tables, no SQL migration — every required column already
existed from SP1 (documents.deletedAt, versions.versionNumber +
unique index, versions.versionNote).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
```

- [ ] **Step 4: Verify tests still green on master**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/web test 2>&1 | tail -5
```

- [ ] **Step 5: Delete the feature branch**

```bash
git branch -D feat/versioning-soft-delete
git branch -a
```

Expected: only `master` remains.

- [ ] **Step 6: Done.**

---

## Notes for the implementer

- **`isUploader` check in the frontend** uses the displayName comparison (`'Mock User'`) as a temporary stand-in. SP4 doesn't expose `uploaderId` on the `DocumentSummary` DTO — adding it is out of scope. SP5 will swap in the proper `user.id === document.uploaderId` check when real Okta auth lands. The mock-user environment makes this distinction moot for Phase 1.
- **Concurrent add-version race test (T5):** if running the two-concurrent-POST case proves flaky on the shared test DB, use `Promise.all` with a small artificial delay (`setTimeout`) between the SELECT MAX and the INSERT to reliably exercise the 23505 path. Both branches need to be observable.
- **DocumentPage anchor sync** must continue to work when the version changes (e.g., user uses the selector to jump from v3 to v1). The threads query key includes `versionId`, so changing the current version triggers a fresh fetch + new anchor set + new `update_anchors` push. The `useEffect` on `[anchorsForCompanion]` handles this; the iframe `src` change also re-runs the `registerSender` flow via the `useEffect` on `[src]` in ArtifactIframe.
- **`useEffect` order in DocumentPage:** the `useEffect` that pushes `update_anchors` on threads change has been there since SP3; it stays. The `registerSender` initial push handles the very first port-open. No additional plumbing needed for version-switching beyond what ArtifactIframe already does on `src` change.
- **AddVersionModal focus management** is light — full focus trap is out of scope; ESC + restoring focus to the trigger is the bare minimum. SP7 polish if it ever proves a problem.
- **Storage type import in the purge job:** `Storage` is exported from `@primer/shared`. Confirm the export exists in the barrel; if not, import from the schema sub-path or add the export to the barrel as a one-line change.
- **Audit findings from prior sub-projects** (5 moderate + 1 low) carry through; not blockers.
