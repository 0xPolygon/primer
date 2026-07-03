# Landing Page Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Primer's home page with a unified document library — search, sort, filter chips, list/cards toggle — and add per-user folders as personal single-level labels.

**Architecture:** Two new tables (`folders`, `document_folders`) scoped to the user. A single new `GET /api/library` endpoint replaces `/api/dashboard` and returns docs + folders + recently-deleted for the caller. Folders never affect access; teammates never see each other's folder structure. Landing route is rewritten around `useLibraryQuery` with a pure `filterAndSort` derivation. Two small additions ship on the doc-detail page: a back-to-folder link and a folder-assignment control.

**Tech Stack:** TypeScript, Hono + Drizzle + Postgres on the API side; React + Vite + TanStack Query on the web side; Vitest (with real Postgres) for tests. pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-07-03-landing-page-overhaul-design.md`](../specs/2026-07-03-landing-page-overhaul-design.md)

**Issue:** [#28](https://github.com/0xPolygon/primer/issues/28)

## Global Constraints

- **Package manager: pnpm.** Never npm. Never yarn.
- **Model: A — per-user folder labels, single-level, single-home per user.** Folders never affect access; a doc's folder assignment for user Alice is invisible to user Bob. Reassignment replaces; unfiling means DELETE the row.
- **Folder name rules.** Server trims before compare/store. Rejects empty/whitespace-only. Max 60 characters post-trim. `409` on case-insensitive duplicate against caller's existing folders. Same name across different users is allowed.
- **Uncategorized is the absence of a `document_folders` row.** Never a sentinel row, never a magic string.
- **Access unchanged.** Every `/api/documents/…` and `/api/library` continues to gate on `visibility = 'org'` OR `uploader_id = caller` OR row in `document_collaborators`. Folder assignment gates on the same read-access check plus "the folder must belong to the caller."
- **`GET /api/dashboard` is deleted in the same PR as the landing UI rewrite (PR 3).** Not before, not after.
- **Sort keys are fixed at four:** `Recent activity` (default), `Recently uploaded`, `Title A→Z`, `Title Z→A`. No direction toggle. No "Most active".
- **Filter chips are fixed at four:** `All`, `Mine`, `Shared with me`, `Deleted`. `Deleted` swaps the doc source to `recentlyDeleted[]` and resets folder highlight to "All docs".
- **Search: client-side only.** Case-insensitive substring match against title + description. Debounced 150ms. No `q=` param on any endpoint.
- **Layout persistence:** `localStorage['primer.library.layout']` ∈ `{"list","cards"}`. Sort persistence: `localStorage['primer.library.sort']` ∈ `{"activity","uploaded","title-asc","title-desc"}`. Folder selection lives in the URL as `?folder=<id>`.
- **Card banner hue is deterministic from doc id.** Same id → same hue across sessions and users.
- **No drag & drop, no bulk multi-select, no server search, no content full-text, no pagination, no nested folders, no shared folders.** These are explicit non-goals from the spec.

## PR / stack layout

Four stacked PRs, in order:

- **PR 1 — Schema + shared types** (Task 1). Zero product surface. Additive migration + Drizzle schema + shared DTOs.
- **PR 2 — API** (Tasks 2–4). Ships all five new endpoints. `/api/dashboard` still works.
- **PR 3 — Landing UI rewrite** (Tasks 5–11). Ships the user-visible change. Deletes `/api/dashboard`, `queries/dashboard.ts`, and `ActivityRow`.
- **PR 4 — Doc detail affordances** (Task 12). Small addition. Depends only on PR 2's assignment endpoint being merged.

Every task ends with a commit. Every PR is opened as **draft** off its predecessor branch, referencing `#28` in commits (`Refs #28`) and closing sub-issues as those are filed. Never push to `master` — master auto-deploys to Railway.

## File structure

### Backend (`apps/api/`)

| Path | Kind | Responsibility |
|---|---|---|
| `apps/api/drizzle/0009_<name>.sql` | Create | Auto-generated migration adding `folders` + `document_folders` |
| `apps/api/src/routes/folders.ts` | Create | `POST/PATCH/DELETE /api/folders`; `registerFolderRoutes` |
| `apps/api/src/routes/folders.test.ts` | Create | Folder CRUD tests with multi-user isolation |
| `apps/api/src/routes/documentFolder.ts` | Create | `PUT /api/documents/:docId/folder`; `registerDocumentFolderRoutes` |
| `apps/api/src/routes/documentFolder.test.ts` | Create | Assignment tests including soft-delete round-trip |
| `apps/api/src/routes/library.ts` | Create | `GET /api/library`; `registerLibraryRoute` |
| `apps/api/src/routes/library.test.ts` | Create | Library endpoint + multi-user + ownership derivation tests |
| `apps/api/src/routes/dashboard.ts` | Delete | Removed in PR 3 (Task 10) |
| `apps/api/src/routes/dashboard.test.ts` | Delete | Removed in PR 3 (Task 10) |
| `apps/api/src/app.ts` | Modify | Register new routes (PR 2), unregister dashboard (PR 3) |

### Shared (`packages/shared/`)

| Path | Kind | Responsibility |
|---|---|---|
| `packages/shared/src/schema.ts` | Modify | Add `folders` + `documentFolders` Drizzle tables |
| `packages/shared/src/api.ts` | Modify | Add `FolderDTO`, `LibraryDocument`, `LibraryResponse` types; remove `DashboardResponse` in PR 3 |

### Web (`apps/web/`)

| Path | Kind | Responsibility |
|---|---|---|
| `apps/web/src/queries/library.ts` | Create | `useLibraryQuery`, `useCreateFolder`, `useRenameFolder`, `useDeleteFolder`, `useAssignFolder` |
| `apps/web/src/queries/dashboard.ts` | Delete | Removed in PR 3 (Task 10) |
| `apps/web/src/lib/library.ts` | Create | Pure `filterAndSort` + comparators + `hashHue(id: string)` |
| `apps/web/src/lib/library.test.ts` | Create | Table-driven tests for filter/sort/hash |
| `apps/web/src/components/LibrarySidebar.tsx` | Create | Folder list, rename/delete affordances, `+ New folder` |
| `apps/web/src/components/LibraryToolbar.tsx` | Create | Search + chips + sort dropdown + layout toggle |
| `apps/web/src/components/DocRow.tsx` | Create | Unified list row (replaces `MyDocumentRow` + `ActivityRow`) |
| `apps/web/src/components/DocCard.tsx` | Create | Card view with hashed banner |
| `apps/web/src/components/DocKebabMenu.tsx` | Create | Shared kebab with `Move to folder ▸` submenu |
| `apps/web/src/components/FolderPickerMenu.tsx` | Create | Menu body reused by kebab + doc-detail control |
| `apps/web/src/components/DocumentListRow.tsx` | Modify | Delete `MyDocumentRow` + `ActivityRow`; keep `DeletedDocumentRow` (still used for Deleted chip) |
| `apps/web/src/routes/home.tsx` | Modify | Rewrite as `LibraryPage` composing all pieces |
| `apps/web/src/routes/document.tsx` | Modify | Add back-to-folder link + folder assignment control (PR 4) |

---

### Task 1: Schema + shared types (PR 1)

**Files:**
- Modify: `packages/shared/src/schema.ts` (add tables at the end of the existing schema block)
- Modify: `packages/shared/src/api.ts` (add new interfaces alongside existing DTOs)
- Create: `apps/api/drizzle/0009_<autogenerated_name>.sql` (via `pnpm db:generate`)
- Modify: `apps/api/drizzle/meta/_journal.json` (auto-updated by drizzle-kit)

**Interfaces (produced for later tasks):**

```ts
// packages/shared/src/schema.ts
export const folders = pgTable(...);         // see step 1 body
export const documentFolders = pgTable(...); // see step 1 body

// packages/shared/src/api.ts
export interface FolderDTO {
  id: string;
  name: string;
  docCount: number;
}
export interface LibraryDocument {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;   // ISO
  createdAt: string;        // ISO
  folderId: string | null;
}
export interface LibraryResponse {
  folders: FolderDTO[];
  documents: LibraryDocument[];
  recentlyDeleted: DeletedDocumentEntry[];   // existing type reused
}
```

- [ ] **Step 1: Add Drizzle tables**

Append to `packages/shared/src/schema.ts`, after `documentCollaborators`:

```ts
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserName: uniqueIndex('folders_user_name_lower_unique').on(t.userId, sql`lower(${t.name})`),
    byUser: index('folders_user_id_idx').on(t.userId),
  }),
);

export const documentFolders = pgTable(
  'document_folders',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
    byFolder: index('document_folders_folder_id_idx').on(t.folderId),
  }),
);
```

- [ ] **Step 2: Add shared DTOs**

Append to `packages/shared/src/api.ts`, alongside the existing `DashboardResponse`:

```ts
export interface FolderDTO {
  id: string;
  name: string;
  docCount: number;
}

export interface LibraryDocument {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  folderId: string | null;
}

export interface LibraryResponse {
  folders: FolderDTO[];
  documents: LibraryDocument[];
  recentlyDeleted: DeletedDocumentEntry[];
}
```

Do **not** delete `DashboardResponse` yet — it goes in PR 3.

- [ ] **Step 3: Generate the migration**

From repo root:
```bash
pnpm db:generate
```
Drizzle writes a new file `apps/api/drizzle/0009_<something>.sql`. Expected contents (order may vary; the important bits are the two `CREATE TABLE` statements, foreign keys, the case-insensitive unique index, and the composite primary key):

```sql
CREATE TABLE "folders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_folders" (
  "user_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "folder_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_folders_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "folders_user_name_lower_unique" ON "folders" USING btree ("user_id", lower("name"));
--> statement-breakpoint
CREATE INDEX "folders_user_id_idx" ON "folders" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "document_folders_folder_id_idx" ON "document_folders" USING btree ("folder_id");
```

If drizzle-kit generates syntactically different output (e.g., quoting differences), keep whatever it emits — do not hand-edit. If it fails to emit the case-insensitive unique index correctly (drizzle-kit has historically been finicky about `sql\`lower(…)\`` in indexes), post-edit the generated SQL to `CREATE UNIQUE INDEX "folders_user_name_lower_unique" ON "folders" ("user_id", lower("name"));` and note the manual edit in the commit body.

- [ ] **Step 4: Apply the migration locally to verify it runs clean**

```bash
pnpm db:migrate
```
Expected: log line ending in `migration complete` with no errors. Then:

```bash
psql -h localhost -U primer -d primer -c '\d folders' -c '\d document_folders'
```
Expected: two tables printed with the columns, indexes, and constraints from step 3. If `psql` is unavailable locally, `pnpm --filter @primer/api exec drizzle-kit introspect` also works.

- [ ] **Step 5: Run the existing test suite to confirm nothing broke**

```bash
pnpm db:migrate:test
pnpm --filter @primer/api test
```
Expected: all existing tests still pass. The new tables are unused by any existing route.

- [ ] **Step 6: Commit**

```bash
git checkout -b issue-28-schema
git add packages/shared/src/schema.ts \
        packages/shared/src/api.ts \
        apps/api/drizzle/0009_*.sql \
        apps/api/drizzle/meta/_journal.json \
        apps/api/drizzle/meta/0009_snapshot.json
git commit -m "feat(schema): add folders + document_folders (per-user labels)

Refs #28"
```

Open PR 1 as **draft**, base `master`, title `feat(schema): folders + document_folders (per-user labels) (#28)`, body summarizing schema-only scope. **Do not push to master.**

---

### Task 2: Folder CRUD API (PR 2)

**Files:**
- Create: `apps/api/src/routes/folders.ts`
- Create: `apps/api/src/routes/folders.test.ts`
- Modify: `apps/api/src/app.ts` (register the route)

**Interfaces (produced):**

```ts
export function registerFolderRoutes(app: Hono<{ Variables: AppVariables }>): void;

// Endpoints:
// POST   /api/folders           body: { name } → 201 FolderDTO | 400 | 409
// PATCH  /api/folders/:folderId body: { name } → 200 FolderDTO | 400 | 404 | 409
// DELETE /api/folders/:folderId                → 204              | 404
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/folders.test.ts`. Use the multi-user harness pattern from `collaborators.test.ts`. Full file:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { Notifier } from '../notifications/notifier.ts';
import type { FolderDTO } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';

class NullNotifier implements Notifier {
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-folders-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /api/folders', () => {
  it('creates a folder for the caller', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('Research');
      expect(body.docCount).toBe(0);
      expect(typeof body.id).toBe('string');
    });
  });

  it('trims the name before storing', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: '  Reading list  ' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('Reading list');
    });
  });

  it('rejects empty and whitespace-only names', async () => {
    await withApp(async (app) => {
      for (const bad of ['', '   ', '\t\n']) {
        const res = await app.request('/api/folders', {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ name: bad }),
        });
        expect(res.status).toBe(400);
      }
    });
  });

  it('rejects names longer than 60 chars post-trim', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'x'.repeat(61) }),
      });
      expect(res.status).toBe(400);
    });
  });

  it('409 on case-insensitive duplicate for same user', async () => {
    await withApp(async (app) => {
      const a = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(a.status).toBe(201);
      const b = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'research' }),
      });
      expect(b.status).toBe(409);
    });
  });

  it('allows the same name across different users', async () => {
    await withApp(async (app) => {
      const a = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const b = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });
  });
});

describe('PATCH /api/folders/:folderId', () => {
  it('renames the caller\'s folder', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'ZK Research' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('ZK Research');
      expect(body.id).toBe(id);
    });
  });

  it('404 when caller is not the owner', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ name: 'Nope' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('409 on case-insensitive duplicate rename', async () => {
    await withApp(async (app) => {
      await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Q3' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'research' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('DELETE /api/folders/:folderId', () => {
  it('deletes the caller\'s folder (204)', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'DELETE',
        headers: asUser('mock-user-1'),
      });
      expect(res.status).toBe(204);
    });
  });

  it('404 when caller is not the owner', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'DELETE',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test folders.test.ts
```
Expected: all tests fail with `404` (route not registered).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/folders.ts`:

```ts
import type { Hono } from 'hono';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables } from '../app.ts';
import type { FolderDTO } from '@primer/shared';
import { folders, documentFolders } from '@primer/shared/schema';
import { db } from '../db/client.ts';

const MAX_NAME_LEN = 60;

function normalizeName(raw: unknown): { ok: true; name: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  if (trimmed.length > MAX_NAME_LEN) return { ok: false };
  return { ok: true, name: trimmed };
}

async function loadCount(userId: string, folderId: string): Promise<number> {
  const [row] = await db.execute<{ count: number }>(drizzleSql`
    SELECT COUNT(*)::int AS count
      FROM document_folders
     WHERE user_id = ${userId}
       AND folder_id = ${folderId}
  `);
  return row?.count ?? 0;
}

export function registerFolderRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.post('/api/folders', async (c) => {
    const userId = c.get('user').id;
    const body = await c.req.json().catch(() => null);
    const normalized = normalizeName(body?.name);
    if (!normalized.ok) return c.json({ error: 'invalid_name' }, 400);

    const id = uuidv7();
    try {
      await db.insert(folders).values({
        id,
        userId,
        name: normalized.name,
      });
    } catch (err) {
      if (String(err).includes('folders_user_name_lower_unique')) {
        return c.json({ error: 'duplicate_name' }, 409);
      }
      throw err;
    }
    const dto: FolderDTO = { id, name: normalized.name, docCount: 0 };
    return c.json(dto, 201);
  });

  app.patch('/api/folders/:folderId', async (c) => {
    const userId = c.get('user').id;
    const folderId = c.req.param('folderId');
    const body = await c.req.json().catch(() => null);
    const normalized = normalizeName(body?.name);
    if (!normalized.ok) return c.json({ error: 'invalid_name' }, 400);

    const [existing] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    try {
      await db
        .update(folders)
        .set({ name: normalized.name, updatedAt: new Date() })
        .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
    } catch (err) {
      if (String(err).includes('folders_user_name_lower_unique')) {
        return c.json({ error: 'duplicate_name' }, 409);
      }
      throw err;
    }
    const docCount = await loadCount(userId, folderId);
    const dto: FolderDTO = { id: folderId, name: normalized.name, docCount };
    return c.json(dto, 200);
  });

  app.delete('/api/folders/:folderId', async (c) => {
    const userId = c.get('user').id;
    const folderId = c.req.param('folderId');
    const result = await db
      .delete(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, userId)))
      .returning({ id: folders.id });
    if (result.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.body(null, 204);
  });
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`, add the import next to the other route imports:

```ts
import { registerFolderRoutes } from './routes/folders.ts';
```

And register it inside `createApp`, next to `registerDashboardRoute(app)`:

```ts
registerFolderRoutes(app);
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
pnpm --filter @primer/api test folders.test.ts
```
Expected: all 10 tests pass. Then run the full suite to confirm no regressions:

```bash
pnpm --filter @primer/api test
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/shared typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git checkout -b issue-28-api                 # off issue-28-schema
git add apps/api/src/routes/folders.ts \
        apps/api/src/routes/folders.test.ts \
        apps/api/src/app.ts
git commit -m "feat(api): folder CRUD endpoints

Refs #28"
```

---

### Task 3: Doc-folder assignment API (PR 2)

**Files:**
- Create: `apps/api/src/routes/documentFolder.ts`
- Create: `apps/api/src/routes/documentFolder.test.ts`
- Modify: `apps/api/src/app.ts` (register)

**Interfaces (consumed):** Task 2's `folders` table exists and `POST /api/folders` works (used in tests to create fixtures).

**Interfaces (produced):**

```ts
export function registerDocumentFolderRoutes(app: Hono<{ Variables: AppVariables }>): void;

// PUT /api/documents/:docId/folder
//   body: { folderId: string | null }
//   → 204 | 400 | 403 | 404
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/documentFolder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users, documents, documentCollaborators, documentFolders } from '@primer/shared/schema';
import type { Notifier } from '../notifications/notifier.ts';
import type { FolderDTO } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class NullNotifier implements Notifier {
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-docfolder-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFolder(app: ReturnType<typeof createApp>, userId: string, name: string): Promise<string> {
  const res = await app.request('/api/folders', {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as FolderDTO).id;
}

describe('PUT /api/documents/:docId/folder', () => {
  it('assigns caller\'s folder to a doc they own (204)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(204);

      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(folderId);
      expect(rows[0].documentId).toBe(upload.documentId);
    });
  });

  it('re-assigns via UPSERT (single-home invariant)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const first = await makeFolder(app, 'mock-user-1', 'Research');
      const second = await makeFolder(app, 'mock-user-1', 'Q3 planning');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: first }),
      });
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: second }),
      });
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(second);
    });
  });

  it('unassigns when folderId is null', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: null }),
      });
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(0);
    });
  });

  it('403 when the folder belongs to a different user', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const otherFolder = await makeFolder(app, 'mock-user-2', 'Their folder');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: otherFolder }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('404 when caller cannot read the doc (private, not owner, not collaborator)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const folderId = await makeFolder(app, 'mock-user-2', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('works for a collaborator on a private doc', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const [{ id: collabId }] = await db
        .insert(documentCollaborators)
        .values({
          id: crypto.randomUUID(),
          documentId: upload.documentId,
          userId: 'mock-user-2',
          role: 'commenter',
          grantedBy: 'mock-user-1',
        })
        .returning({ id: documentCollaborators.id });
      expect(collabId).toBeTruthy();
      const folderId = await makeFolder(app, 'mock-user-2', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(204);
    });
  });

  it('folder assignment persists across soft-delete + restore', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      // soft-delete
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));
      // restore
      await db
        .update(documents)
        .set({ deletedAt: null })
        .where(eq(documents.id, upload.documentId));
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(folderId);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test documentFolder.test.ts
```
Expected: all fail with 404 (route not registered).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/documentFolder.ts`:

```ts
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { documents, documentCollaborators, folders, documentFolders } from '@primer/shared/schema';
import { db } from '../db/client.ts';

async function canReadDoc(docId: string, userId: string): Promise<boolean> {
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!doc || doc.deletedAt !== null) return false;
  if (doc.uploaderId === userId) return true;
  if (doc.visibility === 'org') return true;
  const [collab] = await db
    .select({ userId: documentCollaborators.userId })
    .from(documentCollaborators)
    .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, userId)));
  return !!collab;
}

async function folderBelongsTo(folderId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
  return !!row;
}

export function registerDocumentFolderRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.put('/api/documents/:docId/folder', async (c) => {
    const userId = c.get('user').id;
    const docId = c.req.param('docId');
    const body = await c.req.json().catch(() => null);
    if (body === null || (body.folderId !== null && typeof body.folderId !== 'string')) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    if (!(await canReadDoc(docId, userId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (body.folderId === null) {
      await db
        .delete(documentFolders)
        .where(and(eq(documentFolders.userId, userId), eq(documentFolders.documentId, docId)));
      return c.body(null, 204);
    }
    if (!(await folderBelongsTo(body.folderId, userId))) {
      return c.json({ error: 'folder_forbidden' }, 403);
    }
    await db
      .insert(documentFolders)
      .values({ userId, documentId: docId, folderId: body.folderId })
      .onConflictDoUpdate({
        target: [documentFolders.userId, documentFolders.documentId],
        set: { folderId: body.folderId },
      });
    return c.body(null, 204);
  });
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`, add the import:

```ts
import { registerDocumentFolderRoutes } from './routes/documentFolder.ts';
```

And register alongside `registerFolderRoutes(app)`:

```ts
registerDocumentFolderRoutes(app);
```

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm --filter @primer/api test documentFolder.test.ts
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/documentFolder.ts \
        apps/api/src/routes/documentFolder.test.ts \
        apps/api/src/app.ts
git commit -m "feat(api): PUT /api/documents/:docId/folder for per-user assignment

Refs #28"
```

---

### Task 4: Library endpoint (PR 2)

**Files:**
- Create: `apps/api/src/routes/library.ts`
- Create: `apps/api/src/routes/library.test.ts`
- Modify: `apps/api/src/app.ts` (register)

**Interfaces (consumed):** `documentFolders` and `folders` tables from Task 1; folder/assignment endpoints from Tasks 2–3 (used in tests to build fixtures).

**Interfaces (produced):**

```ts
export function registerLibraryRoute(app: Hono<{ Variables: AppVariables }>): void;
// GET /api/library → 200 LibraryResponse
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/library.test.ts`. Key coverage: docs the caller can read, ownership derivation, `folderId` per caller, `folders[].docCount`, `recentlyDeleted` scope, cross-user isolation.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users, documents, documentCollaborators } from '@primer/shared/schema';
import type { Notifier } from '../notifications/notifier.ts';
import type { LibraryResponse, FolderDTO } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class NullNotifier implements Notifier {
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-library-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFolder(app: ReturnType<typeof createApp>, userId: string, name: string): Promise<string> {
  const res = await app.request('/api/folders', {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as FolderDTO).id;
}

async function assignFolder(app: ReturnType<typeof createApp>, userId: string, docId: string, folderId: string | null) {
  await app.request(`/api/documents/${docId}/folder`, {
    method: 'PUT',
    headers: asUserJson(userId),
    body: JSON.stringify({ folderId }),
  });
}

describe('GET /api/library', () => {
  it('returns docs the caller uploaded', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request('/api/library', { headers: asUser('mock-user-1') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as LibraryResponse;
      const mine = body.documents.find((d) => d.id === upload.documentId);
      expect(mine).toBeDefined();
      expect(mine?.ownership).toBe('mine');
      expect(mine?.folderId).toBeNull();
    });
  });

  it('org docs are visible with ownership=org to other users', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as LibraryResponse;
      const other = body.documents.find((d) => d.id === upload.documentId);
      expect(other).toBeDefined();
      expect(other?.ownership).toBe('org');
    });
  });

  it('private doc: hidden from strangers, visible with ownership=collaborator to collaborators', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));

      const strangerRes = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const strangerBody = (await strangerRes.json()) as LibraryResponse;
      expect(strangerBody.documents.find((d) => d.id === upload.documentId)).toBeUndefined();

      await db.insert(documentCollaborators).values({
        id: crypto.randomUUID(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const collabRes = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const collabBody = (await collabRes.json()) as LibraryResponse;
      const found = collabBody.documents.find((d) => d.id === upload.documentId);
      expect(found?.ownership).toBe('collaborator');
    });
  });

  it('folderId reflects only the caller\'s assignment (no leakage)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderA = await makeFolder(app, 'mock-user-1', 'Research');
      await assignFolder(app, 'mock-user-1', upload.documentId, folderA);

      const bodyA = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(bodyA.documents.find((d) => d.id === upload.documentId)?.folderId).toBe(folderA);

      const bodyB = (await (await app.request('/api/library', { headers: asUser('mock-user-2') })).json()) as LibraryResponse;
      expect(bodyB.documents.find((d) => d.id === upload.documentId)?.folderId).toBeNull();
      expect(bodyB.folders).toEqual([]);
    });
  });

  it('folders[].docCount reflects caller assignments only', async () => {
    await withApp(async (app) => {
      const up1 = await uploadFixture(app);
      const up2 = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await assignFolder(app, 'mock-user-1', up1.documentId, folderId);
      await assignFolder(app, 'mock-user-1', up2.documentId, folderId);

      const body = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      const f = body.folders.find((x) => x.id === folderId);
      expect(f?.docCount).toBe(2);
    });
  });

  it('recentlyDeleted returns only caller\'s own soft-deleted docs', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const mine = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(mine.recentlyDeleted.find((d) => d.id === upload.documentId)).toBeDefined();

      const other = (await (await app.request('/api/library', { headers: asUser('mock-user-2') })).json()) as LibraryResponse;
      expect(other.recentlyDeleted.find((d) => d.id === upload.documentId)).toBeUndefined();
    });
  });

  it('soft-deleted docs are excluded from `documents`', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));
      const body = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(body.documents.find((d) => d.id === upload.documentId)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @primer/api test library.test.ts
```
Expected: all fail with 404.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/library.ts`. This adapts the existing SQL in `dashboard.ts` and layers in the folder + ownership + permission bits:

```ts
import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { LibraryResponse, LibraryDocument, FolderDTO, DeletedDocumentEntry } from '@primer/shared';
import { db } from '../db/client.ts';

interface DocRow {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string | Date;
  createdAt: string | Date;
  folderId: string | null;
}

interface FolderRow {
  id: string;
  name: string;
  docCount: number;
}

interface DeletedRow {
  id: string;
  title: string;
  deletedAt: string | Date;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseInt(String(v), 10);
}

export function registerLibraryRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/library', async (c) => {
    const userId = c.get('user').id;

    // Docs the caller can read: own OR org OR collaborator.
    const docRows = (await db.execute(sql`
      WITH version_threads AS (
        SELECT v.document_id, t.id AS thread_id, t.resolved_at,
               GREATEST(t.created_at, COALESCE(t.resolved_at, t.created_at)) AS thread_activity
          FROM versions v
     LEFT JOIN threads t ON t.version_id = v.id
      ),
      version_comments AS (
        SELECT v.document_id,
               GREATEST(c.created_at, COALESCE(c.updated_at, c.created_at), COALESCE(c.deleted_at, c.created_at)) AS comment_activity
          FROM versions v
     LEFT JOIN threads t ON t.version_id = v.id
     LEFT JOIN comments c ON c.thread_id = t.id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        d.uploader_id       AS "uploaderId",
        d.visibility,
        u.display_name      AS "uploaderDisplayName",
        CASE
          WHEN d.uploader_id = ${userId} THEN 'mine'
          WHEN EXISTS (SELECT 1 FROM document_collaborators dc
                         WHERE dc.document_id = d.id AND dc.user_id = ${userId}) THEN 'collaborator'
          ELSE 'org'
        END                 AS ownership,
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL)::int                              AS "threadCount",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL AND vt.resolved_at IS NULL)::int   AS "activeThreadCount",
        GREATEST(
          d.created_at,
          COALESCE(MAX(vt.thread_activity), d.created_at),
          COALESCE(MAX(vc.comment_activity), d.created_at)
        )                   AS "lastActivityAt",
        d.created_at        AS "createdAt",
        df.folder_id        AS "folderId"
      FROM documents d
      INNER JOIN users u              ON u.id = d.uploader_id
      LEFT JOIN document_folders df   ON df.document_id = d.id AND df.user_id = ${userId}
      LEFT JOIN version_threads vt    ON vt.document_id = d.id
      LEFT JOIN version_comments vc   ON vc.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND (
          d.visibility = 'org'
          OR d.uploader_id = ${userId}
          OR EXISTS (SELECT 1 FROM document_collaborators dc
                       WHERE dc.document_id = d.id AND dc.user_id = ${userId})
        )
      GROUP BY d.id, d.title, d.description, d.uploader_id, d.visibility, u.display_name, d.created_at, df.folder_id
      ORDER BY "lastActivityAt" DESC
    `)) as unknown as DocRow[];

    const folderRows = (await db.execute(sql`
      SELECT f.id,
             f.name,
             COUNT(df.document_id)::int AS "docCount"
        FROM folders f
   LEFT JOIN document_folders df ON df.folder_id = f.id AND df.user_id = ${userId}
       WHERE f.user_id = ${userId}
    GROUP BY f.id, f.name
    ORDER BY lower(f.name) ASC
    `)) as unknown as FolderRow[];

    const deletedRows = (await db.execute(sql`
      SELECT id, title, deleted_at AS "deletedAt"
        FROM documents
       WHERE uploader_id = ${userId}
         AND deleted_at IS NOT NULL
         AND deleted_at > now() - interval '30 days'
    ORDER BY deleted_at DESC
    `)) as unknown as DeletedRow[];

    const documentsOut: LibraryDocument[] = docRows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderId: r.uploaderId,
      uploaderDisplayName: r.uploaderDisplayName,
      visibility: r.visibility,
      ownership: r.ownership,
      threadCount: toInt(r.threadCount),
      activeThreadCount: toInt(r.activeThreadCount),
      lastActivityAt: toIso(r.lastActivityAt),
      createdAt: toIso(r.createdAt),
      folderId: r.folderId,
    }));

    const foldersOut: FolderDTO[] = folderRows.map((r) => ({
      id: r.id,
      name: r.name,
      docCount: toInt(r.docCount),
    }));

    const recentlyDeleted: DeletedDocumentEntry[] = deletedRows.map((r) => {
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

    const body: LibraryResponse = { folders: foldersOut, documents: documentsOut, recentlyDeleted };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`:

```ts
import { registerLibraryRoute } from './routes/library.ts';
```
Registered alongside the folder routes:

```ts
registerLibraryRoute(app);
```

Do **not** remove `registerDashboardRoute(app)` yet — that happens in PR 3.

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm --filter @primer/api test library.test.ts
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```
Expected: all pass.

- [ ] **Step 6: Commit + open PR 2**

```bash
git add apps/api/src/routes/library.ts \
        apps/api/src/routes/library.test.ts \
        apps/api/src/app.ts
git commit -m "feat(api): GET /api/library for unified doc browser

Refs #28"
```

Open PR 2 as **draft**, base `issue-28-schema` (or `master` if PR 1 is already merged), branch `issue-28-api`, title `feat(api): folders + assignments + /api/library (#28)`, body summarizing the three endpoints and calling out that `/api/dashboard` is untouched here (removed in PR 3).

---

### Task 5: Client queries + pure library logic (PR 3, foundation)

**Files:**
- Create: `apps/web/src/lib/library.ts`
- Create: `apps/web/src/lib/library.test.ts`
- Create: `apps/web/src/queries/library.ts`

**Interfaces (consumed):** `LibraryResponse`, `LibraryDocument`, `FolderDTO` from Task 1.

**Interfaces (produced):**

```ts
// lib/library.ts
export type Chip = 'all' | 'mine' | 'shared' | 'deleted';
export type SortKey = 'activity' | 'uploaded' | 'title-asc' | 'title-desc';
export interface FilterOpts {
  folderId: string | null;   // null = "All docs"; explicit "" = Uncategorized
  chip: Chip;
  q: string;
  sortKey: SortKey;
}
export function filterAndSort(docs: LibraryDocument[], opts: FilterOpts): LibraryDocument[];
export function hashHue(id: string): number;                       // 0..359
export function normalizeFolderNameClient(raw: string): { ok: true; name: string } | { ok: false; reason: 'empty' | 'too-long' };

// queries/library.ts
export function useLibraryQuery(): UseQueryResult<LibraryResponse>;
export function useCreateFolder(): UseMutationResult<FolderDTO, Error, { name: string }>;
export function useRenameFolder(): UseMutationResult<FolderDTO, Error, { id: string; name: string }>;
export function useDeleteFolder(): UseMutationResult<void, Error, { id: string }>;
export function useAssignFolder(): UseMutationResult<void, Error, { docId: string; folderId: string | null }>;
```

`folderId: null` in `FilterOpts` means "All docs" (no folder filter). `folderId: ''` (empty string) means "Uncategorized" (only docs where `LibraryDocument.folderId === null`). This is the one place a magic value exists; every consumer imports it via a named constant.

- [ ] **Step 1: Write the failing tests for `library.ts`**

Create `apps/web/src/lib/library.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterAndSort, hashHue, normalizeFolderNameClient, FOLDER_UNCATEGORIZED } from './library';
import type { LibraryDocument } from '@primer/shared';

function doc(partial: Partial<LibraryDocument>): LibraryDocument {
  return {
    id: 'd1',
    title: 'Doc',
    description: null,
    uploaderId: 'u1',
    uploaderDisplayName: 'User One',
    visibility: 'org',
    ownership: 'mine',
    threadCount: 0,
    activeThreadCount: 0,
    lastActivityAt: '2026-07-01T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
    folderId: null,
    ...partial,
  };
}

describe('filterAndSort', () => {
  it('folderId=null shows all docs', () => {
    const docs = [doc({ id: 'a', folderId: null }), doc({ id: 'b', folderId: 'f1' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('folderId=FOLDER_UNCATEGORIZED shows only unfiled docs', () => {
    const docs = [doc({ id: 'a', folderId: null }), doc({ id: 'b', folderId: 'f1' })];
    const out = filterAndSort(docs, { folderId: FOLDER_UNCATEGORIZED, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('folderId=<real> shows only docs in that folder', () => {
    const docs = [doc({ id: 'a', folderId: 'f1' }), doc({ id: 'b', folderId: 'f2' }), doc({ id: 'c', folderId: null })];
    const out = filterAndSort(docs, { folderId: 'f1', chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('chip=mine keeps ownership==="mine"', () => {
    const docs = [doc({ id: 'a', ownership: 'mine' }), doc({ id: 'b', ownership: 'org' }), doc({ id: 'c', ownership: 'collaborator' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'mine', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('chip=shared keeps ownership org OR collaborator', () => {
    const docs = [doc({ id: 'a', ownership: 'mine' }), doc({ id: 'b', ownership: 'org' }), doc({ id: 'c', ownership: 'collaborator' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'shared', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id).sort()).toEqual(['b', 'c']);
  });

  it('q matches title case-insensitively', () => {
    const docs = [doc({ id: 'a', title: 'Onboarding' }), doc({ id: 'b', title: 'ZK research' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: 'onboard', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('q matches description case-insensitively', () => {
    const docs = [doc({ id: 'a', title: 'X', description: 'about onboarding' }), doc({ id: 'b', title: 'Y', description: null })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: 'ONBOARD', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('sortKey=activity is descending by lastActivityAt', () => {
    const docs = [
      doc({ id: 'a', lastActivityAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'b', lastActivityAt: '2026-07-03T00:00:00Z' }),
      doc({ id: 'c', lastActivityAt: '2026-07-02T00:00:00Z' }),
    ];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('sortKey=uploaded is descending by createdAt', () => {
    const docs = [
      doc({ id: 'a', createdAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'b', createdAt: '2026-07-03T00:00:00Z' }),
    ];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'uploaded' });
    expect(out.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('sortKey=title-asc is locale-aware, case-insensitive', () => {
    const docs = [doc({ id: 'a', title: 'zebra' }), doc({ id: 'b', title: 'Apple' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'title-asc' });
    expect(out.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('sortKey=title-desc is the reverse of title-asc', () => {
    const docs = [doc({ id: 'a', title: 'zebra' }), doc({ id: 'b', title: 'Apple' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'title-desc' });
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('intersection: folder AND chip AND q all narrow together', () => {
    const docs = [
      doc({ id: 'a', folderId: 'f1', ownership: 'mine', title: 'Onboarding' }),
      doc({ id: 'b', folderId: 'f1', ownership: 'org', title: 'Onboarding' }),
      doc({ id: 'c', folderId: 'f2', ownership: 'mine', title: 'Onboarding' }),
      doc({ id: 'd', folderId: 'f1', ownership: 'mine', title: 'Other' }),
    ];
    const out = filterAndSort(docs, { folderId: 'f1', chip: 'mine', q: 'onboard', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });
});

describe('hashHue', () => {
  it('is deterministic for a given id', () => {
    expect(hashHue('doc-123')).toBe(hashHue('doc-123'));
  });
  it('produces a value in [0, 360)', () => {
    for (const id of ['a', 'bbbb', 'x'.repeat(50), '0000-0000-0000']) {
      const h = hashHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  it('gives different hues for different ids (spot check)', () => {
    expect(hashHue('a')).not.toBe(hashHue('z'));
  });
});

describe('normalizeFolderNameClient', () => {
  it('trims and accepts', () => {
    expect(normalizeFolderNameClient('  Research  ')).toEqual({ ok: true, name: 'Research' });
  });
  it('rejects empty', () => {
    expect(normalizeFolderNameClient('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeFolderNameClient('')).toEqual({ ok: false, reason: 'empty' });
  });
  it('rejects too long', () => {
    expect(normalizeFolderNameClient('x'.repeat(61))).toEqual({ ok: false, reason: 'too-long' });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @primer/web test library.test.ts
```
Expected: fail (module missing).

- [ ] **Step 3: Implement `lib/library.ts`**

```ts
import type { LibraryDocument } from '@primer/shared';

export const FOLDER_UNCATEGORIZED = '' as const;

export type Chip = 'all' | 'mine' | 'shared' | 'deleted';
export type SortKey = 'activity' | 'uploaded' | 'title-asc' | 'title-desc';

export interface FilterOpts {
  folderId: string | null;   // null = All; FOLDER_UNCATEGORIZED = Uncategorized; other = folder id
  chip: Chip;
  q: string;
  sortKey: SortKey;
}

const MAX_NAME = 60;

export function normalizeFolderNameClient(raw: string):
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too-long' } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_NAME) return { ok: false, reason: 'too-long' };
  return { ok: true, name: trimmed };
}

function matchesFolder(d: LibraryDocument, folderId: string | null): boolean {
  if (folderId === null) return true;
  if (folderId === FOLDER_UNCATEGORIZED) return d.folderId === null;
  return d.folderId === folderId;
}

function matchesChip(d: LibraryDocument, chip: Chip): boolean {
  switch (chip) {
    case 'all':
      return true;
    case 'mine':
      return d.ownership === 'mine';
    case 'shared':
      return d.ownership === 'org' || d.ownership === 'collaborator';
    case 'deleted':
      // 'deleted' chip is handled by swapping data source in the page,
      // not by filtering LibraryDocument[]. This branch should never run
      // on live docs — return true so callers who misuse it still see docs.
      return true;
  }
}

function matchesQuery(d: LibraryDocument, q: string): boolean {
  if (q.length === 0) return true;
  const needle = q.toLowerCase();
  if (d.title.toLowerCase().includes(needle)) return true;
  if (d.description && d.description.toLowerCase().includes(needle)) return true;
  return false;
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const comparators: Record<SortKey, (a: LibraryDocument, b: LibraryDocument) => number> = {
  activity: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
  uploaded: (a, b) => b.createdAt.localeCompare(a.createdAt),
  'title-asc': (a, b) => titleCollator.compare(a.title, b.title),
  'title-desc': (a, b) => titleCollator.compare(b.title, a.title),
};

export function filterAndSort(docs: LibraryDocument[], opts: FilterOpts): LibraryDocument[] {
  return docs
    .filter((d) => matchesFolder(d, opts.folderId))
    .filter((d) => matchesChip(d, opts.chip))
    .filter((d) => matchesQuery(d, opts.q))
    .slice()
    .sort(comparators[opts.sortKey]);
}

export function hashHue(id: string): number {
  // FNV-1a 32-bit, deterministic, no library needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @primer/web test library.test.ts
```
Expected: all pass.

- [ ] **Step 5: Implement `queries/library.ts`**

Create `apps/web/src/queries/library.ts`:

```ts
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { LibraryResponse, FolderDTO } from '@primer/shared';
import { api } from '../lib/fetch.ts';

const LIBRARY_KEY = ['library'] as const;

export function useLibraryQuery() {
  return useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: async ({ signal }): Promise<LibraryResponse> => {
      const res = await api('/api/library', { signal });
      if (!res.ok) throw new Error(`library fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useCreateFolder(): UseMutationResult<FolderDTO, Error, { name: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name }) => {
      const res = await api('/api/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`create folder failed: ${res.status}`);
      return (await res.json()) as FolderDTO;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useRenameFolder(): UseMutationResult<FolderDTO, Error, { id: string; name: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }) => {
      const res = await api(`/api/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`rename folder failed: ${res.status}`);
      return (await res.json()) as FolderDTO;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useDeleteFolder(): UseMutationResult<void, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      const res = await api(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete folder failed: ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useAssignFolder(): UseMutationResult<void, Error, { docId: string; folderId: string | null }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId, folderId }) => {
      const res = await api(`/api/documents/${encodeURIComponent(docId)}/folder`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(`assign folder failed: ${res.status}`);
    },
    onMutate: async ({ docId, folderId }) => {
      await qc.cancelQueries({ queryKey: LIBRARY_KEY });
      const previous = qc.getQueryData<LibraryResponse>(LIBRARY_KEY);
      if (previous) {
        qc.setQueryData<LibraryResponse>(LIBRARY_KEY, {
          ...previous,
          documents: previous.documents.map((d) => (d.id === docId ? { ...d, folderId } : d)),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(LIBRARY_KEY, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git checkout -b issue-28-ui                  # off issue-28-api
git add apps/web/src/lib/library.ts \
        apps/web/src/lib/library.test.ts \
        apps/web/src/queries/library.ts
git commit -m "feat(web): library query hooks + pure filter/sort logic

Refs #28"
```

---

### Task 6: LibraryToolbar (PR 3)

**Files:**
- Create: `apps/web/src/components/LibraryToolbar.tsx`

**Interfaces (consumed):** `Chip`, `SortKey` from `lib/library.ts`.

**Interfaces (produced):**

```ts
export interface LibraryToolbarProps {
  q: string;
  onQChange: (q: string) => void;      // parent debounces if it wants
  chip: Chip;
  onChipChange: (chip: Chip) => void;
  sortKey: SortKey;
  onSortKeyChange: (k: SortKey) => void;
  layout: 'list' | 'cards';
  onLayoutChange: (l: 'list' | 'cards') => void;
  showFoldersButton?: boolean;          // shown on mobile
  onOpenFolders?: () => void;
}
export function LibraryToolbar(props: LibraryToolbarProps): JSX.Element;
```

- [ ] **Step 1: Implement the toolbar**

Create `apps/web/src/components/LibraryToolbar.tsx`:

```tsx
import type { Chip, SortKey } from '../lib/library.ts';

export interface LibraryToolbarProps {
  q: string;
  onQChange: (q: string) => void;
  chip: Chip;
  onChipChange: (chip: Chip) => void;
  sortKey: SortKey;
  onSortKeyChange: (k: SortKey) => void;
  layout: 'list' | 'cards';
  onLayoutChange: (l: 'list' | 'cards') => void;
  showFoldersButton?: boolean;
  onOpenFolders?: () => void;
}

const CHIPS: ReadonlyArray<{ key: Chip; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'shared', label: 'Shared with me' },
  { key: 'deleted', label: 'Deleted' },
];

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'activity', label: 'Recent activity' },
  { key: 'uploaded', label: 'Recently uploaded' },
  { key: 'title-asc', label: 'Title A→Z' },
  { key: 'title-desc', label: 'Title Z→A' },
];

export function LibraryToolbar(props: LibraryToolbarProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-neutral-200 pb-3 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        {props.showFoldersButton && (
          <button
            type="button"
            onClick={props.onOpenFolders}
            className="md:hidden rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            Folders ▾
          </button>
        )}
        <input
          type="search"
          value={props.q}
          onChange={(e) => props.onQChange(e.target.value)}
          placeholder="Search…"
          className="flex-1 rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex items-center gap-2 overflow-x-auto">
        <div className="flex gap-1 shrink-0" role="tablist" aria-label="Filter">
          {CHIPS.map((c) => {
            const active = c.key === props.chip;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => props.onChipChange(c.key)}
                className={
                  'rounded-full px-3 py-1 text-xs whitespace-nowrap ' +
                  (active
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700')
                }
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <label className="text-xs text-neutral-500">
            Sort{' '}
            <select
              value={props.sortKey}
              onChange={(e) => props.onSortKeyChange(e.target.value as SortKey)}
              className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            <button
              type="button"
              aria-label="List view"
              aria-pressed={props.layout === 'list'}
              onClick={() => props.onLayoutChange('list')}
              className={
                'px-2 py-1 text-xs ' +
                (props.layout === 'list' ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : '')
              }
            >
              ▤
            </button>
            <button
              type="button"
              aria-label="Cards view"
              aria-pressed={props.layout === 'cards'}
              onClick={() => props.onLayoutChange('cards')}
              className={
                'px-2 py-1 text-xs ' +
                (props.layout === 'cards' ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : '')
              }
            >
              ▦
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/LibraryToolbar.tsx
git commit -m "feat(web): LibraryToolbar (search, chips, sort, layout)

Refs #28"
```

---

### Task 7: LibrarySidebar + FolderPickerMenu (PR 3)

**Files:**
- Create: `apps/web/src/components/LibrarySidebar.tsx`
- Create: `apps/web/src/components/FolderPickerMenu.tsx`

**Interfaces (consumed):** `FolderDTO`, `useCreateFolder`, `useRenameFolder`, `useDeleteFolder`, `useAssignFolder` from Task 5.

**Interfaces (produced):**

```ts
// LibrarySidebar.tsx
export interface LibrarySidebarProps {
  folders: FolderDTO[];
  uncategorizedCount: number;
  totalCount: number;
  selectedFolderId: string | null;      // null = All, '' = Uncategorized, other = folder id
  onSelect: (folderId: string | null) => void;
}
export function LibrarySidebar(props: LibrarySidebarProps): JSX.Element;

// FolderPickerMenu.tsx
export interface FolderPickerMenuProps {
  folders: FolderDTO[];
  currentFolderId: string | null;      // null means the doc is currently uncategorized
  onPick: (folderId: string | null) => void;      // null = "None (Uncategorized)"
  onCreateAndPick: (name: string) => void;         // creates folder, then assigns
  onClose: () => void;
}
export function FolderPickerMenu(props: FolderPickerMenuProps): JSX.Element;
```

- [ ] **Step 1: Implement `LibrarySidebar.tsx`**

```tsx
import { useState } from 'react';
import type { FolderDTO } from '@primer/shared';
import { FOLDER_UNCATEGORIZED } from '../lib/library.ts';
import {
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
} from '../queries/library.ts';
import { normalizeFolderNameClient } from '../lib/library.ts';

export interface LibrarySidebarProps {
  folders: FolderDTO[];
  uncategorizedCount: number;
  totalCount: number;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
}

export function LibrarySidebar(props: LibrarySidebarProps) {
  const create = useCreateFolder();
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const submitCreate = () => {
    const normalized = normalizeFolderNameClient(draftName);
    if (!normalized.ok) {
      setCreateError(normalized.reason === 'empty' ? 'Name required' : 'Too long (max 60)');
      return;
    }
    create.mutate(
      { name: normalized.name },
      {
        onSuccess: () => {
          setDraftName('');
          setIsAdding(false);
          setCreateError(null);
        },
        onError: (e) => {
          setCreateError(String(e).includes('409') ? 'Name already used' : 'Could not create');
        },
      },
    );
  };

  return (
    <aside className="hidden md:flex md:w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 pr-4 text-sm dark:border-neutral-800">
      <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Folders</div>
      <SidebarLink
        label="All docs"
        count={props.totalCount}
        active={props.selectedFolderId === null}
        onClick={() => props.onSelect(null)}
      />
      <SidebarLink
        label="Uncategorized"
        count={props.uncategorizedCount}
        active={props.selectedFolderId === FOLDER_UNCATEGORIZED}
        onClick={() => props.onSelect(FOLDER_UNCATEGORIZED)}
      />
      <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
      {props.folders.map((f) => (
        <FolderRow
          key={f.id}
          folder={f}
          active={props.selectedFolderId === f.id}
          onSelect={() => props.onSelect(f.id)}
        />
      ))}
      <div className="mt-2">
        {isAdding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
            className="flex flex-col gap-1"
          >
            <input
              autoFocus
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                setCreateError(null);
              }}
              onBlur={() => {
                if (draftName.trim().length === 0) {
                  setIsAdding(false);
                  setCreateError(null);
                }
              }}
              placeholder="New folder name"
              className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              disabled={create.isPending}
            />
            {createError && <span className="text-xs text-red-600 dark:text-red-400">{createError}</span>}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            + New folder
          </button>
        )}
      </div>
    </aside>
  );
}

function SidebarLink(props: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        'flex items-center justify-between rounded px-2 py-1 text-left ' +
        (props.active
          ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800')
      }
    >
      <span>{props.label}</span>
      <span className="text-xs text-neutral-500">{props.count}</span>
    </button>
  );
}

function FolderRow(props: { folder: FolderDTO; active: boolean; onSelect: () => void }) {
  const rename = useRenameFolder();
  const del = useDeleteFolder();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.folder.name);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const normalized = normalizeFolderNameClient(draft);
    if (!normalized.ok) {
      setError(normalized.reason === 'empty' ? 'Name required' : 'Too long (max 60)');
      return;
    }
    if (normalized.name === props.folder.name) {
      setEditing(false);
      return;
    }
    rename.mutate(
      { id: props.folder.id, name: normalized.name },
      {
        onSuccess: () => {
          setEditing(false);
          setError(null);
        },
        onError: (e) => setError(String(e).includes('409') ? 'Name already used' : 'Could not rename'),
      },
    );
  };

  const askDelete = () => {
    if (window.confirm(`Delete folder "${props.folder.name}"? Docs in it will become Uncategorized in your view.`)) {
      del.mutate({ id: props.folder.id });
    }
  };

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-1 px-2 py-1"
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onBlur={submit}
          className="rounded border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          disabled={rename.isPending}
        />
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </form>
    );
  }

  return (
    <div
      className={
        'group flex items-center justify-between rounded px-2 py-1 ' +
        (props.active
          ? 'bg-neutral-100 dark:bg-neutral-800'
          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
      }
    >
      <button type="button" onClick={props.onSelect} className="flex-1 min-w-0 text-left">
        <span className="truncate block">{props.folder.name}</span>
      </button>
      <div className="flex items-center gap-1">
        <span className="text-xs text-neutral-500">{props.folder.docCount}</span>
        <div className="hidden group-hover:flex items-center gap-1">
          <button
            type="button"
            aria-label="Rename"
            onClick={() => setEditing(true)}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label="Delete"
            onClick={askDelete}
            className="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
            disabled={del.isPending}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `FolderPickerMenu.tsx`**

```tsx
import { useState } from 'react';
import type { FolderDTO } from '@primer/shared';
import { normalizeFolderNameClient } from '../lib/library.ts';

export interface FolderPickerMenuProps {
  folders: FolderDTO[];
  currentFolderId: string | null;
  onPick: (folderId: string | null) => void;
  onCreateAndPick: (name: string) => void;
  onClose: () => void;
}

export function FolderPickerMenu(props: FolderPickerMenuProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submitNew = () => {
    const normalized = normalizeFolderNameClient(draft);
    if (!normalized.ok) {
      setError(normalized.reason === 'empty' ? 'Name required' : 'Too long (max 60)');
      return;
    }
    props.onCreateAndPick(normalized.name);
    props.onClose();
  };

  return (
    <div className="min-w-[220px] rounded border border-neutral-200 bg-white p-1 shadow-md dark:border-neutral-700 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => {
          props.onPick(null);
          props.onClose();
        }}
        className={
          'flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ' +
          (props.currentFolderId === null ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
        }
      >
        <span>None (Uncategorized)</span>
        {props.currentFolderId === null && <span aria-hidden>✓</span>}
      </button>
      {props.folders.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => {
            props.onPick(f.id);
            props.onClose();
          }}
          className={
            'flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ' +
            (props.currentFolderId === f.id ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
          }
        >
          <span className="truncate">{f.name}</span>
          {props.currentFolderId === f.id && <span aria-hidden>✓</span>}
        </button>
      ))}
      <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitNew();
          }}
          className="flex flex-col gap-1 px-2 py-1"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="New folder name"
            className="rounded border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full rounded px-2 py-1 text-left text-sm text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          + New folder…
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/LibrarySidebar.tsx \
        apps/web/src/components/FolderPickerMenu.tsx
git commit -m "feat(web): LibrarySidebar + FolderPickerMenu

Refs #28"
```

---

### Task 8: DocRow refactor + DocKebabMenu (PR 3)

**Files:**
- Create: `apps/web/src/components/DocRow.tsx`
- Create: `apps/web/src/components/DocKebabMenu.tsx`

**Interfaces (consumed):** `LibraryDocument`, `FolderDTO`, `useAssignFolder`, `useCreateFolder`, `FolderPickerMenu` from earlier tasks.

**Interfaces (produced):**

```ts
export interface DocRowProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}
export function DocRow(props: DocRowProps): JSX.Element;

export interface DocKebabMenuProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}
export function DocKebabMenu(props: DocKebabMenuProps): JSX.Element;
```

- [ ] **Step 1: Implement `DocKebabMenu.tsx`**

```tsx
import { useState, useRef, useEffect } from 'react';
import type { LibraryDocument, FolderDTO } from '@primer/shared';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocKebabMenuProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}

export function DocKebabMenu({ doc, folders }: DocKebabMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const assign = useAssignFolder();
  const create = useCreateFolder();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const handleCreateAndPick = (name: string) => {
    create.mutate(
      { name },
      {
        onSuccess: (folder) => {
          assign.mutate({ docId: doc.id, folderId: folder.id });
        },
      },
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="More"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1" onClick={(e) => e.stopPropagation()}>
          <FolderPickerMenu
            folders={folders}
            currentFolderId={doc.folderId}
            onPick={(folderId) => assign.mutate({ docId: doc.id, folderId })}
            onCreateAndPick={handleCreateAndPick}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement `DocRow.tsx`**

Model on today's `MyDocumentRow`, but read `ownership` for the subtitle and include `DocKebabMenu`.

```tsx
import { Link } from 'react-router-dom';
import type { LibraryDocument, FolderDTO } from '@primer/shared';
import { PrivateLockIcon } from './PrivateLockIcon.tsx';
import { DocKebabMenu } from './DocKebabMenu.tsx';

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

export interface DocRowProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}

export function DocRow({ doc, folders }: DocRowProps) {
  const subtitle =
    doc.ownership === 'mine'
      ? doc.description ?? ''
      : `by ${doc.uploaderDisplayName}${doc.description ? ` · ${doc.description}` : ''}`;

  return (
    <div className="group flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800">
      <Link to={`/d/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100 min-w-0">
            {doc.visibility === 'private' && (
              <PrivateLockIcon className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
            )}
            <span className="truncate">{doc.title}</span>
          </span>
          <span className="text-xs text-neutral-500 truncate">
            {subtitle || <em className="text-neutral-400 dark:text-neutral-500">no description</em>}
          </span>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs text-neutral-600 dark:text-neutral-400">
          {doc.threadCount === 0
            ? 'no threads yet'
            : `${doc.activeThreadCount}/${doc.threadCount} active`}
        </span>
        <span className="hidden sm:inline w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
        <DocKebabMenu doc={doc} folders={folders} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DocRow.tsx \
        apps/web/src/components/DocKebabMenu.tsx
git commit -m "feat(web): DocRow + DocKebabMenu with per-user folder assignment

Refs #28"
```

---

### Task 9: DocCard (PR 3)

**Files:**
- Create: `apps/web/src/components/DocCard.tsx`

**Interfaces (consumed):** `LibraryDocument`, `FolderDTO`, `hashHue`, `DocKebabMenu`.

**Interfaces (produced):**

```ts
export interface DocCardProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}
export function DocCard(props: DocCardProps): JSX.Element;
```

- [ ] **Step 1: Implement `DocCard.tsx`**

```tsx
import { Link } from 'react-router-dom';
import type { LibraryDocument, FolderDTO } from '@primer/shared';
import { PrivateLockIcon } from './PrivateLockIcon.tsx';
import { DocKebabMenu } from './DocKebabMenu.tsx';
import { hashHue } from '../lib/library.ts';

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

export interface DocCardProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}

export function DocCard({ doc, folders }: DocCardProps) {
  const hue = hashHue(doc.id);
  const hue2 = (hue + 40) % 360;
  const banner =
    doc.visibility === 'private'
      ? { background: 'linear-gradient(135deg, hsl(220, 15%, 25%), hsl(220, 15%, 45%))' }
      : { background: `linear-gradient(135deg, hsl(${hue}, 65%, 55%), hsl(${hue2}, 65%, 55%))` };

  const byline = doc.ownership === 'mine' ? 'just you' : `by ${doc.uploaderDisplayName}`;

  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900">
      <Link to={`/d/${doc.id}`} className="block">
        <div className="h-9 w-full relative" style={banner}>
          {doc.visibility === 'private' && (
            <span className="absolute left-2 top-2 flex items-center gap-1 text-xs text-white">
              <PrivateLockIcon className="h-3 w-3" />
              private
            </span>
          )}
        </div>
        <div className="p-3">
          <div className="line-clamp-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {doc.title}
          </div>
          <div className="mt-1 line-clamp-2 h-8 text-xs text-neutral-500">
            {doc.description ?? <em className="text-neutral-400 dark:text-neutral-600">no description</em>}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500">
            <span className="truncate">
              {byline} · {relativeTime(doc.lastActivityAt)}
            </span>
            <span>
              {doc.threadCount === 0 ? 'no threads' : `${doc.activeThreadCount}/${doc.threadCount} active`}
            </span>
          </div>
        </div>
      </Link>
      <div className="absolute right-2 top-2">
        <DocKebabMenu doc={doc} folders={folders} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/DocCard.tsx
git commit -m "feat(web): DocCard with deterministic hashed banner

Refs #28"
```

---

### Task 10: LibraryPage integration + remove old dashboard (PR 3)

**Files:**
- Modify: `apps/web/src/routes/home.tsx` (full rewrite)
- Modify: `apps/web/src/components/DocumentListRow.tsx` (remove `MyDocumentRow` + `ActivityRow`; keep `DeletedDocumentRow`)
- Delete: `apps/web/src/queries/dashboard.ts`
- Delete: `apps/api/src/routes/dashboard.ts`
- Delete: `apps/api/src/routes/dashboard.test.ts`
- Modify: `apps/api/src/app.ts` (remove `registerDashboardRoute`)
- Modify: `packages/shared/src/api.ts` (remove `DashboardResponse`, `DashboardDocumentSummary`, `DashboardActivityEntry` — `DeletedDocumentEntry` stays; it's used by `LibraryResponse`)

**Interfaces (consumed):** everything from Tasks 5–9.

**Interfaces (produced):**

```ts
export function HomePage(): JSX.Element;   // exported name unchanged so App.tsx isn't touched
```

- [ ] **Step 1: Rewrite `apps/web/src/routes/home.tsx`**

Replace the entire file with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLibraryQuery } from '../queries/library.ts';
import {
  filterAndSort,
  FOLDER_UNCATEGORIZED,
  type Chip,
  type SortKey,
} from '../lib/library.ts';
import { LibraryToolbar } from '../components/LibraryToolbar.tsx';
import { LibrarySidebar } from '../components/LibrarySidebar.tsx';
import { DocRow } from '../components/DocRow.tsx';
import { DocCard } from '../components/DocCard.tsx';
import { DeletedDocumentRow } from '../components/DocumentListRow.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';

const LAYOUT_KEY = 'primer.library.layout';
const SORT_KEY = 'primer.library.sort';

function readLayout(): 'list' | 'cards' {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === 'activity' || v === 'uploaded' || v === 'title-asc' || v === 'title-desc') return v;
  } catch { /* ignore */ }
  return 'activity';
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function HomePage() {
  const q = useLibraryQuery();
  const [params, setParams] = useSearchParams();
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [chip, setChip] = useState<Chip>('all');
  const [layout, setLayout] = useState<'list' | 'cards'>(() => readLayout());
  const [sortKey, setSortKey] = useState<SortKey>(() => readSort());
  const [qInput, setQInput] = useState('');
  const qDebounced = useDebounced(qInput, 150);

  // URL-synced folder selection.
  const folderIdRaw = params.get('folder');
  const folderId: string | null =
    folderIdRaw === null ? null : folderIdRaw === '' ? FOLDER_UNCATEGORIZED : folderIdRaw;

  const setFolderId = (next: string | null) => {
    const p = new URLSearchParams(params);
    if (next === null) p.delete('folder');
    else p.set('folder', next);
    setParams(p, { replace: true });
  };

  // Persist layout + sort.
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* ignore */ }
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sortKey); } catch { /* ignore */ }
  }, [sortKey]);

  // 'Deleted' chip → reset folder highlight to All docs.
  useEffect(() => {
    if (chip === 'deleted' && folderId !== null) setFolderId(null);
  }, [chip]);

  const data = q.data;

  const uncategorizedCount = useMemo(
    () => (data ? data.documents.filter((d) => d.folderId === null).length : 0),
    [data],
  );

  const visibleDocs = useMemo(() => {
    if (!data) return [];
    if (chip === 'deleted') return [];
    return filterAndSort(data.documents, { folderId, chip, q: qDebounced, sortKey });
  }, [data, folderId, chip, qDebounced, sortKey]);

  const deletedFiltered = useMemo(() => {
    if (!data || chip !== 'deleted') return [];
    const needle = qDebounced.trim().toLowerCase();
    return needle
      ? data.recentlyDeleted.filter((d) => d.title.toLowerCase().includes(needle))
      : data.recentlyDeleted;
  }, [data, chip, qDebounced]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <div className="hidden md:flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddVersion(true)}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            + Add new version
          </button>
          <Link
            to="/upload"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Upload document
          </Link>
        </div>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && (
        <div className="text-sm text-red-600 dark:text-red-400">
          Could not load library: {(q.error as Error).message}
        </div>
      )}

      {data && (
        <div className="flex gap-6">
          <LibrarySidebar
            folders={data.folders}
            uncategorizedCount={uncategorizedCount}
            totalCount={data.documents.length}
            selectedFolderId={folderId}
            onSelect={setFolderId}
          />
          <main className="flex-1 min-w-0 space-y-3">
            <LibraryToolbar
              q={qInput}
              onQChange={setQInput}
              chip={chip}
              onChipChange={setChip}
              sortKey={sortKey}
              onSortKeyChange={setSortKey}
              layout={layout}
              onLayoutChange={setLayout}
            />

            {chip === 'deleted' ? (
              deletedFiltered.length === 0 ? (
                <EmptyState message="No recently deleted documents." />
              ) : (
                <div>
                  {deletedFiltered.map((entry) => (
                    <DeletedDocumentRow key={entry.id} entry={entry} />
                  ))}
                </div>
              )
            ) : visibleDocs.length === 0 ? (
              <LibraryEmpty
                totalDocs={data.documents.length}
                folderId={folderId}
                folderName={data.folders.find((f) => f.id === folderId)?.name ?? null}
                chip={chip}
                q={qDebounced}
                onClearSearch={() => setQInput('')}
                onClearFilters={() => {
                  setChip('all');
                  setFolderId(null);
                }}
              />
            ) : layout === 'list' ? (
              <div>
                {visibleDocs.map((d) => (
                  <DocRow key={d.id} doc={d} folders={data.folders} />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {visibleDocs.map((d) => (
                  <DocCard key={d.id} doc={d} folders={data.folders} />
                ))}
              </div>
            )}
          </main>
        </div>
      )}

      <AddVersionModal open={showAddVersion} onClose={() => setShowAddVersion(false)} />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="px-1 py-4 text-sm italic text-neutral-500">{message}</div>;
}

function LibraryEmpty(props: {
  totalDocs: number;
  folderId: string | null;
  folderName: string | null;
  chip: Chip;
  q: string;
  onClearSearch: () => void;
  onClearFilters: () => void;
}) {
  // Zero docs library-wide (new user).
  if (props.totalDocs === 0) {
    return (
      <div className="px-2 py-8 text-center">
        <blockquote className="mx-auto max-w-lg text-sm italic leading-relaxed text-neutral-600 dark:text-neutral-400">
          &ldquo;The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a
          separate flat-panel display, which formed itself into pictures, words, and animations responsive to the
          reader.&rdquo;
        </blockquote>
        <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">— Neal Stephenson, <em>The Diamond Age</em></p>
        <p className="mt-6 text-sm text-neutral-500">
          No documents yet.{' '}
          <Link to="/upload" className="font-medium text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100">
            Upload your first one
          </Link>
          .
        </p>
      </div>
    );
  }
  if (props.q.length > 0) {
    return (
      <div className="px-1 py-4 text-sm text-neutral-500">
        No docs matching &ldquo;{props.q}&rdquo;.{' '}
        <button type="button" onClick={props.onClearSearch} className="underline">
          Clear search
        </button>
      </div>
    );
  }
  if (props.folderName) {
    return (
      <div className="px-1 py-4 text-sm text-neutral-500">
        Nothing in <strong>{props.folderName}</strong> yet. Move docs here from the ⋯ menu.
      </div>
    );
  }
  return (
    <div className="px-1 py-4 text-sm text-neutral-500">
      No documents match this view.{' '}
      <button type="button" onClick={props.onClearFilters} className="underline">
        Clear filters
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Trim `DocumentListRow.tsx`**

Open `apps/web/src/components/DocumentListRow.tsx` and remove **only** `MyDocumentRow` and `ActivityRow` (and their supporting `MyDocProps`/`ActivityProps` interfaces + the `import type { DashboardActivityEntry, DashboardDocumentSummary }` symbols they use). Keep the top-of-file `relativeTime` helper (used by `DeletedDocumentRow`), keep `DeletedDocumentRow`, and keep its `DeletedRowProps` interface. The imports left at the top should now be:

```tsx
import type { DeletedDocumentEntry } from '@primer/shared';
import { useRestoreDocument } from '../queries/documents.ts';
```

- [ ] **Step 3: Delete the old dashboard files**

```bash
git rm apps/web/src/queries/dashboard.ts \
       apps/api/src/routes/dashboard.ts \
       apps/api/src/routes/dashboard.test.ts
```

- [ ] **Step 4: Remove `registerDashboardRoute` from `app.ts`**

In `apps/api/src/app.ts`, delete the `import { registerDashboardRoute } from './routes/dashboard.ts';` line and the `registerDashboardRoute(app);` call.

- [ ] **Step 5: Remove dead types from `@primer/shared`**

Open `packages/shared/src/api.ts` and remove `DashboardResponse`, `DashboardDocumentSummary`, `DashboardActivityEntry`. Keep `DeletedDocumentEntry` (still referenced by `LibraryResponse`).

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @primer/api test
pnpm --filter @primer/web test
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
pnpm --filter @primer/shared typecheck
```
Expected: everything green. If any file still imports `DashboardResponse` / `useDashboardQuery` / etc., grep and remove — the strictest signal that the removal is clean is `grep -R "dashboard" apps/web/src apps/api/src packages/shared/src` returning only comments (e.g. the phrase inside `versionContent.ts` about "interactive dashboards" that predates this ticket).

- [ ] **Step 7: Manual verification (mandatory)**

Local run:

```bash
pnpm --filter @primer/api dev &     # starts API + Postgres already running
pnpm --filter @primer/web dev
```

Open `http://localhost:5173/` and confirm:

- Landing shows the sidebar + toolbar + doc list.
- Creating a folder, renaming it, deleting it works and updates counts.
- Assigning a doc to a folder via the ⋯ menu moves it into that folder's view.
- The `All / Mine / Shared with me / Deleted` chips filter as expected.
- `?folder=<id>` in the URL persists across reload.
- Switching to card view shows the hashed banner; toggling back to list persists on reload.
- Sort options change ordering.
- Search filters as you type (~150ms debounce).

Stop the dev servers.

- [ ] **Step 8: Commit + open PR 3**

```bash
git add apps/web/src/routes/home.tsx \
        apps/web/src/components/DocumentListRow.tsx \
        apps/api/src/app.ts \
        packages/shared/src/api.ts
git commit -m "feat(web): unified library landing page + drop /api/dashboard

Refs #28"
```

Open PR 3 as **draft**, base `issue-28-api`, branch `issue-28-ui`, title `feat(web): unified library landing + per-user folders (#28)`. Include screenshots of list view, cards view, empty state, and mobile if you can grab one.

---

### Task 11: Mobile folder bottom-sheet (PR 3)

**Files:**
- Modify: `apps/web/src/routes/home.tsx` (wire the bottom-sheet)
- Create: `apps/web/src/components/MobileFoldersSheet.tsx`

**Interfaces (consumed):** `BottomSheet` from `apps/web/src/components/BottomSheet.tsx`.

**Interfaces (produced):**

```ts
export interface MobileFoldersSheetProps {
  open: boolean;
  folders: FolderDTO[];
  uncategorizedCount: number;
  totalCount: number;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onClose: () => void;
}
export function MobileFoldersSheet(props: MobileFoldersSheetProps): JSX.Element;
```

- [ ] **Step 1: Read the existing BottomSheet API**

```bash
sed -n '1,60p' apps/web/src/components/BottomSheet.tsx
```
Understand what props it takes (snap points, open state, close callback). Do not modify `BottomSheet.tsx`.

- [ ] **Step 2: Implement `MobileFoldersSheet.tsx`**

Compose `BottomSheet` with a scrollable list of folders + `All docs` / `Uncategorized` shortcuts + a `+ New folder` inline input. This reuses the same `useCreateFolder` mutation and matches `LibrarySidebar` semantics. Match the sizing/API of `BottomSheet` as it exists in the codebase (do not invent new snap point names — use whatever the existing component exposes).

Reuse the same folder-row rendering logic as `LibrarySidebar` by extracting a shared `FolderListItem` if it feels natural; otherwise inline. Keep it small — this is a mobile-only surface.

- [ ] **Step 3: Wire it into `home.tsx`**

Add `showFoldersButton` + `onOpenFolders` on `LibraryToolbar`, and render `<MobileFoldersSheet open={foldersOpen} …/>` at the bottom of `HomePage`. Toggle a `foldersOpen` state.

- [ ] **Step 4: Manual verification**

```bash
pnpm --filter @primer/web dev
```
Open with a narrow viewport (Chrome DevTools mobile, ~375px). Confirm:
- Sidebar is hidden.
- `Folders ▾` button in the toolbar opens the bottom sheet.
- Selecting a folder inside the sheet dismisses it and updates the URL/list.
- Adding a folder from inside the sheet works.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/MobileFoldersSheet.tsx \
        apps/web/src/routes/home.tsx
git commit -m "feat(web): mobile folder picker bottom-sheet

Refs #28"
```

PR 3 now covers Tasks 5–11 as one draft PR.

---

### Task 12: Doc detail affordances (PR 4)

**Files:**
- Modify: `apps/web/src/routes/document.tsx` (add back-link and folder assignment control in the header)

**Interfaces (consumed):** `useLibraryQuery`, `useAssignFolder`, `useCreateFolder`, `FolderPickerMenu`. The `LibraryResponse` already exposes `folderId` per doc and the caller's folders — no new endpoint needed.

**Interfaces (produced):** No new exports; purely in-file UI additions to `DocumentPage`.

- [ ] **Step 1: Read the current header block**

```bash
sed -n '1,300p' apps/web/src/routes/document.tsx
```
Locate the title / description / visibility button cluster in the header. Do not restructure the file — just add two elements.

- [ ] **Step 2: Add a back-to-folder link above the title**

Inside `DocumentPageInner`, near where the title is rendered, add (using `useLibraryQuery` inside the same component; it's cheap because react-query will hit cache if the user came from the landing page):

```tsx
import { useLibraryQuery, useAssignFolder, useCreateFolder } from '../queries/library.ts';
import { FolderPickerMenu } from '../components/FolderPickerMenu.tsx';
import { Link } from 'react-router-dom';   // already imported; skip if present
```

Then within the render:

```tsx
const libraryQ = useLibraryQuery();
const libDoc = libraryQ.data?.documents.find((d) => d.id === docId);
const folders = libraryQ.data?.folders ?? [];
const currentFolder = libDoc?.folderId ? folders.find((f) => f.id === libDoc.folderId) : null;
```

Above the existing title element:

```tsx
{currentFolder && (
  <Link
    to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
    className="mb-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
  >
    ← {currentFolder.name}
  </Link>
)}
```

- [ ] **Step 3: Add a folder-assignment control in the header button cluster**

Adjacent to the existing visibility/share/delete buttons, add:

```tsx
{libDoc && (
  <FolderControl
    docId={libDoc.id}
    currentFolderId={libDoc.folderId}
    currentFolderName={currentFolder?.name ?? null}
    folders={folders}
  />
)}
```

Define `FolderControl` at the bottom of the file, or in a small helper file `apps/web/src/components/DocDetailFolderControl.tsx` if you want to keep `document.tsx` from growing further (a fair call — the file is already 800+ lines). If extracting:

```tsx
// apps/web/src/components/DocDetailFolderControl.tsx
import { useState, useRef, useEffect } from 'react';
import type { FolderDTO } from '@primer/shared';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocDetailFolderControlProps {
  docId: string;
  currentFolderId: string | null;
  currentFolderName: string | null;
  folders: FolderDTO[];
}

export function DocDetailFolderControl({ docId, currentFolderId, currentFolderName, folders }: DocDetailFolderControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const assign = useAssignFolder();
  const create = useCreateFolder();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const label = currentFolderName ? `In: ${currentFolderName} ▾` : 'Add to folder ▾';

  const handleCreateAndPick = (name: string) => {
    create.mutate(
      { name },
      { onSuccess: (folder) => assign.mutate({ docId, folderId: folder.id }) },
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {label}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1">
          <FolderPickerMenu
            folders={folders}
            currentFolderId={currentFolderId}
            onPick={(folderId) => assign.mutate({ docId, folderId })}
            onCreateAndPick={handleCreateAndPick}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
```

Then import it in `document.tsx`.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

- [ ] **Step 5: Manual verification**

```bash
pnpm --filter @primer/web dev
```

- File a doc into a folder from the landing page. Open the doc.
  - Expect: back-to-folder link renders above the title. Clicking it navigates to `/?folder=<id>`.
  - Expect: header shows `In: <Folder> ▾`. Click it → picker opens with current folder checked.
- Open a doc that's uncategorized in your view.
  - Expect: no back-link. Header shows `Add to folder ▾`. Assigning a folder updates the button label live and shows the back-link.

- [ ] **Step 6: Commit + open PR 4**

```bash
git checkout -b issue-28-doc-detail        # off issue-28-ui or master (once PR 3 is merged)
git add apps/web/src/routes/document.tsx \
        apps/web/src/components/DocDetailFolderControl.tsx
git commit -m "feat(web): back-to-folder link + assignment control on doc detail

Refs #28"
```

Open PR 4 as **draft**, base `issue-28-ui` (or `master` if PR 3 has landed), title `feat(web): doc detail folder affordances (#28)`, body summarizing the two additions.

---

## Self-Review Notes

Ran against the spec:

- ✅ **Folder model, single-home per user** — Task 1 PK on `(user_id, document_id)`, Task 3 UPSERT.
- ✅ **Access unchanged** — Task 3 uses `canReadDoc` mirroring existing visibility + collaborator check; Task 4 SQL filters `visibility='org' OR uploader OR collab`.
- ✅ **All 5 endpoints** — Tasks 2 (`POST/PATCH/DELETE /api/folders`), 3 (`PUT /api/documents/:docId/folder`), 4 (`GET /api/library`).
- ✅ **`/api/dashboard` deleted with the UI PR** — Task 10 explicitly.
- ✅ **All 4 chips + 4 sort keys** — `library.ts` in Task 5 covers both sets exactly.
- ✅ **URL sync of folder + localStorage for layout + sort** — Task 10.
- ✅ **Client-side search + intersection** — `filterAndSort` in Task 5, integrated in Task 10.
- ✅ **Card banner deterministic hue** — `hashHue` in Task 5, wired in Task 9.
- ✅ **Doc detail back-link + folder control** — Task 12.
- ✅ **Empty states (5 kinds)** — Task 10's `LibraryEmpty` + inline "no recently deleted" branch.
- ✅ **Mobile bottom-sheet** — Task 11.
- ✅ **Non-goals** — no drag/bulk/nested/shared/server-search/pagination/most-active anywhere in the plan.
- ✅ **Testing** — folders.test.ts, documentFolder.test.ts, library.test.ts, library.test.ts (web pure logic). No React component render tests (matches repo convention — the codebase does not use @testing-library; pure logic is where testing lives).
