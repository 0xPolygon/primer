# Doc Collaborators — Sub 1: Permission Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the behavior-preserving foundation for the doc collaborators feature — schema (`visibility` column + `document_collaborators` table), a central `permissions` module (`canRead`/`canComment`/`canEdit`/`canManage`), and route every HTTP + MCP path listed in the spec through those helpers.

**Architecture:** Additive schema (nullable-defaulted `visibility` column + new table). A pure permissions module with two layers: (a) pure helpers over `(visibility, effectiveRole)` for decision-making and (b) thin DB helpers to load a user's collaborator role. Existing routes fetch the extra column, resolve the caller's effective role, and delegate to the helpers. Default behavior for existing rows (`visibility='org'`, empty collab table) is bit-identical to today.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, drizzle-kit for migrations, Postgres, Vitest (`environment: 'node'`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-02-doc-collaborators-design.md`
**Issue:** [#39 (Sub 1 of #29)](https://github.com/0xPolygon/primer/issues/39)

## Global Constraints

- Package manager: **pnpm only**. Never `npm`. Every install: `pnpm install`. CI uses `--frozen-lockfile`.
- Supply-chain gate (workspace-level, already in `pnpm-workspace.yaml`): `minimumReleaseAge: 14d`, `allowBuilds: {}`, `blockExoticSubdeps`. This plan adds no new dependencies.
- Module imports inside `apps/api/src` and `packages/shared/src` use explicit `.ts` extensions (e.g. `'./lib/permissions.ts'`). Match the existing convention in every new import.
- Vitest is configured with `environment: 'node'`, `fileParallelism: false`, tests hit a real `primer_test` Postgres DB (`DATABASE_URL_TEST`). Tests seed DB rows directly; do **not** mock the DB.
- Migrations are generated via `pnpm --filter @primer/api db:generate`. Never hand-write a `.sql` file — check the generated output in and only edit it if drizzle-kit's output is wrong.
- The schema source of truth is `packages/shared/src/schema.ts`. Only add/edit that file to change tables; drizzle-kit generates the migration from it.
- All new/updated route handlers must fetch `documents.visibility` alongside `uploaderId`/`deletedAt` in a single query — never round-trip twice. Load the caller's collaborator role via `loadCollaboratorRole(docId, userId)` from the permissions module.
- Behavior parity is a hard requirement of this sub-issue: every existing test must pass unchanged unless it depends on an implementation detail we're deliberately replacing. If a test starts failing, first confirm the failure represents an intentional behavior change from the spec — otherwise fix the code, not the test.
- 404 vs 403: read paths return **404** on `canRead=false` (privacy-preserving; matches soft-delete behavior). Write paths return **403** on `canRead=true` but `canEdit=false` (you see it, can't touch it), and **404** on `canRead=false`.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `packages/shared/src/schema.ts` | Add `visibility` col + `document_collaborators` table | 1 |
| `apps/api/drizzle/0008_<generated-slug>.sql` | Auto-generated migration | 1 |
| `apps/api/drizzle/meta/*` | Auto-updated by drizzle-kit | 1 |
| `apps/api/src/lib/permissions.ts` | Pure permission helpers + DB helpers | 2, 3 |
| `apps/api/src/lib/permissions.test.ts` | Unit tests for pure + DB helpers | 2, 3 |
| `apps/api/src/routes/documents.ts` | Wire GET/PATCH/DELETE/restore + versions endpoints | 4 |
| `apps/api/src/routes/documents.test.ts` | Update assertions where needed | 4 |
| `apps/api/src/routes/versions.ts` | Wire PATCH version-note | 5 |
| `apps/api/src/routes/versionContent.ts` | Wire GET version content | 5 |
| `apps/api/src/routes/versions.test.ts` | Extend | 5 |
| `apps/api/src/routes/versionContent.test.ts` | Extend | 5 |
| `apps/api/src/routes/threads.ts` | Wire list/create/resolve/reopen | 6 |
| `apps/api/src/routes/threads.test.ts` | Extend | 6 |
| `apps/api/src/routes/comments.ts` | Wire create/PATCH/DELETE | 7 |
| `apps/api/src/routes/comments.test.ts` | Extend | 7 |
| `apps/api/src/routes/dashboard.ts` | Filter recently-viewed-or-commented in SQL | 8 |
| `apps/api/src/routes/dashboard.test.ts` | Extend | 8 |
| `apps/api/src/mcp/tools.ts` | Wire get_document / get_version_content / list_versions / get_comments / add_version | 9 |
| `apps/api/src/mcp/tools.test.ts` | Extend | 9 |
| `apps/api/src/test/crossUser.test.ts` | Add collaborator scenarios (owner/editor/commenter/stranger × org/private) | 10 |

Each task ends with an independently-committable change and its own commit.

---

### Task 1: Schema — add `visibility` column and `document_collaborators` table

**Files:**
- Modify: `packages/shared/src/schema.ts` (add one column to `documents`; add one new table)
- Create (auto-generated): `apps/api/drizzle/0008_<slug>.sql` and `apps/api/drizzle/meta/*` updates

**Interfaces:**
- Consumes: nothing
- Produces:
  - `documents.visibility` — `'org' | 'private'`, `NOT NULL`, default `'org'`
  - `documentCollaborators` table with columns `id: uuid PK`, `documentId: uuid FK→documents(id) ON DELETE CASCADE`, `userId: text FK→users(id) ON DELETE CASCADE`, `role: 'commenter' | 'editor'`, `grantedBy: text FK→users(id)`, `createdAt: timestamptz`
  - Unique index on `(document_id, user_id)`; index on `user_id` for "Shared with me" queries in Sub 4

- [ ] **Step 1: Add the `visibility` column and the new table to the schema**

Modify `packages/shared/src/schema.ts`. Add the `visibility` column to the existing `documents` table definition; the change is a single new field:

```ts
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  visibility: text('visibility', { enum: ['org', 'private'] }).notNull().default('org'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
```

Then, immediately after the `documentViews` table definition (line 100 area — keep tables grouped by domain), add:

```ts
export const documentCollaborators = pgTable(
  'document_collaborators',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['commenter', 'editor'] }).notNull(),
    grantedBy: text('granted_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocUser: uniqueIndex('document_collaborators_doc_user_unique').on(
      t.documentId,
      t.userId,
    ),
    byUser: index('document_collaborators_user_id_idx').on(t.userId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
pnpm --filter @primer/api db:generate
```

Expected: drizzle-kit prints a summary showing one column added to `documents` and one new table `document_collaborators`. A new file appears under `apps/api/drizzle/` (name will be `0008_<random-slug>.sql`) and `apps/api/drizzle/meta/_journal.json` is updated.

- [ ] **Step 3: Inspect the generated SQL**

Open the new `apps/api/drizzle/0008_*.sql` and confirm it contains:
- `ALTER TABLE "documents" ADD COLUMN "visibility" text DEFAULT 'org' NOT NULL;` (with a `CHECK` constraint if drizzle-kit emits one for the enum — either is fine)
- `CREATE TABLE "document_collaborators" ( ... )` with the columns above
- Two foreign key `ALTER TABLE ... ADD CONSTRAINT` statements (documentId cascades, userId cascades, grantedBy no cascade)
- `CREATE UNIQUE INDEX "document_collaborators_doc_user_unique" ON ...`
- `CREATE INDEX "document_collaborators_user_id_idx" ON ...`

If drizzle-kit generated anything unexpected (renames, drops, extra tables), **stop and diagnose** — do not hand-edit unless the output is plainly wrong.

- [ ] **Step 4: Apply the migration to both dev and test databases**

Run:
```bash
pnpm --filter @primer/api db:migrate
pnpm --filter @primer/api db:migrate:test
```

Expected: each prints `Migrations applied.` and exits 0.

- [ ] **Step 5: Verify the schema in Postgres**

Run:
```bash
psql "postgres://primer:primer@localhost:5432/primer_test" -c '\d+ documents' -c '\d+ document_collaborators'
```

Expected: `documents` shows a `visibility` column (`text`, `not null`, default `'org'::text`). `document_collaborators` shows all six columns, the FKs, the unique index, and the user_id index.

- [ ] **Step 6: Confirm existing tests still pass (behavior parity)**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: full suite green. Nothing in the code reads `visibility` or `document_collaborators` yet — the migration is additive and the default `'org'` matches today's behavior exactly.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schema.ts apps/api/drizzle/
git commit -m "$(cat <<'EOF'
feat(schema): add documents.visibility + document_collaborators table

Additive schema for the collaborators feature: nullable-defaulted
`visibility` column on documents (default 'org' preserves current
share-by-URL behavior) plus a new document_collaborators table
(document_id, user_id, role, granted_by, created_at) with unique
(doc,user) and per-user index.

Refs #39
EOF
)"
```

---

### Task 2: Permissions module — pure helpers (TDD)

**Files:**
- Create: `apps/api/src/lib/permissions.ts`
- Create: `apps/api/src/lib/permissions.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - Types: `Visibility = 'org' | 'private'`, `CollaboratorRole = 'commenter' | 'editor'`, `EffectiveRole = 'owner' | 'editor' | 'commenter' | 'stranger'`
  - `effectiveRole(doc: { uploaderId: string; visibility: Visibility }, userId: string, collabRole: CollaboratorRole | null): EffectiveRole`
  - `canRead(visibility: Visibility, role: EffectiveRole): boolean`
  - `canComment(visibility: Visibility, role: EffectiveRole): boolean`
  - `canEdit(role: EffectiveRole): boolean`
  - `canManage(role: EffectiveRole): boolean`

- [ ] **Step 1: Write the failing tests for the full permission matrix**

Create `apps/api/src/lib/permissions.test.ts` with the full matrix from the spec:

```ts
import { describe, it, expect } from 'vitest';
import {
  effectiveRole,
  canRead,
  canComment,
  canEdit,
  canManage,
  type Visibility,
  type CollaboratorRole,
  type EffectiveRole,
} from './permissions.ts';

describe('effectiveRole', () => {
  const doc = { uploaderId: 'owner-1', visibility: 'org' as Visibility };

  it('returns "owner" when userId matches uploaderId', () => {
    expect(effectiveRole(doc, 'owner-1', null)).toBe('owner');
    expect(effectiveRole(doc, 'owner-1', 'editor')).toBe('owner'); // owner beats collab
  });
  it('returns "editor" when user is editor collab and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', 'editor')).toBe('editor');
  });
  it('returns "commenter" when user is commenter collab and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', 'commenter')).toBe('commenter');
  });
  it('returns "stranger" when no collab row and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', null)).toBe('stranger');
  });
});

describe('canRead', () => {
  it('everyone reads under org visibility', () => {
    for (const r of ['owner', 'editor', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canRead('org', r)).toBe(true);
    }
  });
  it('only owner + collabs read under private visibility', () => {
    expect(canRead('private', 'owner')).toBe(true);
    expect(canRead('private', 'editor')).toBe(true);
    expect(canRead('private', 'commenter')).toBe(true);
    expect(canRead('private', 'stranger')).toBe(false);
  });
});

describe('canComment', () => {
  it('everyone comments under org visibility', () => {
    for (const r of ['owner', 'editor', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canComment('org', r)).toBe(true);
    }
  });
  it('only owner + collabs comment under private visibility', () => {
    expect(canComment('private', 'owner')).toBe(true);
    expect(canComment('private', 'editor')).toBe(true);
    expect(canComment('private', 'commenter')).toBe(true);
    expect(canComment('private', 'stranger')).toBe(false);
  });
});

describe('canEdit', () => {
  it('owner and editor can edit; commenter and stranger cannot', () => {
    expect(canEdit('owner')).toBe(true);
    expect(canEdit('editor')).toBe(true);
    expect(canEdit('commenter')).toBe(false);
    expect(canEdit('stranger')).toBe(false);
  });
});

describe('canManage', () => {
  it('only owner can manage', () => {
    expect(canManage('owner')).toBe(true);
    expect(canManage('editor')).toBe(false);
    expect(canManage('commenter')).toBe(false);
    expect(canManage('stranger')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test permissions.test
```

Expected: all tests fail with `Cannot find module './permissions.ts'`.

- [ ] **Step 3: Implement the pure helpers**

Create `apps/api/src/lib/permissions.ts`:

```ts
export type Visibility = 'org' | 'private';
export type CollaboratorRole = 'commenter' | 'editor';
export type EffectiveRole = 'owner' | 'editor' | 'commenter' | 'stranger';

export function effectiveRole(
  doc: { uploaderId: string; visibility: Visibility },
  userId: string,
  collabRole: CollaboratorRole | null,
): EffectiveRole {
  if (doc.uploaderId === userId) return 'owner';
  if (collabRole === 'editor') return 'editor';
  if (collabRole === 'commenter') return 'commenter';
  return 'stranger';
}

export function canRead(visibility: Visibility, role: EffectiveRole): boolean {
  if (visibility === 'org') return true;
  return role !== 'stranger';
}

export function canComment(visibility: Visibility, role: EffectiveRole): boolean {
  // Same as canRead: reading implies the ability to comment.
  return canRead(visibility, role);
}

export function canEdit(role: EffectiveRole): boolean {
  return role === 'owner' || role === 'editor';
}

export function canManage(role: EffectiveRole): boolean {
  return role === 'owner';
}
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @primer/api test permissions.test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/permissions.ts apps/api/src/lib/permissions.test.ts
git commit -m "$(cat <<'EOF'
feat(permissions): pure helpers for doc access decisions

effectiveRole + canRead/canComment/canEdit/canManage matching the
permission matrix from the spec. All four combinations of visibility
and role covered by unit tests.

Refs #39
EOF
)"
```

---

### Task 3: Permissions module — DB helpers

**Files:**
- Modify: `apps/api/src/lib/permissions.ts` (add two DB-touching helpers)
- Modify: `apps/api/src/lib/permissions.test.ts` (add DB-integration tests)

**Interfaces:**
- Consumes: `db` from `apps/api/src/db/client.ts`; `documentCollaborators` schema
- Produces:
  - `loadCollaboratorRole(docId: string, userId: string): Promise<CollaboratorRole | null>` — one row lookup
  - `loadCollaboratorRoles(docIds: string[], userId: string): Promise<Map<string, CollaboratorRole>>` — bulk lookup for list surfaces

- [ ] **Step 1: Write the failing DB-integration tests**

Append to `apps/api/src/lib/permissions.test.ts`:

```ts
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, users, documentCollaborators } from '@primer/shared/schema';
import { loadCollaboratorRole, loadCollaboratorRoles } from './permissions.ts';

async function seedUser(id: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, email: `${id}@x.test`, displayName: id })
    .onConflictDoNothing();
}

async function seedDoc(ownerId: string): Promise<string> {
  const docId = uuidv7();
  await db.insert(documents).values({
    id: docId,
    title: 't',
    description: null,
    uploaderId: ownerId,
  });
  return docId;
}

describe('loadCollaboratorRole', () => {
  it('returns null when no row exists', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-other');
    const docId = await seedDoc('perm-owner');
    const role = await loadCollaboratorRole(docId, 'perm-other');
    expect(role).toBeNull();
  });

  it('returns the stored role when a row exists', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-editor');
    const docId = await seedDoc('perm-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(),
      documentId: docId,
      userId: 'perm-editor',
      role: 'editor',
      grantedBy: 'perm-owner',
    });
    const role = await loadCollaboratorRole(docId, 'perm-editor');
    expect(role).toBe('editor');
  });
});

describe('loadCollaboratorRoles (bulk)', () => {
  it('returns a map keyed by documentId for docs the user collaborates on', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-both');
    const docA = await seedDoc('perm-owner');
    const docB = await seedDoc('perm-owner');
    const docC = await seedDoc('perm-owner');
    await db.insert(documentCollaborators).values([
      { id: uuidv7(), documentId: docA, userId: 'perm-both', role: 'editor', grantedBy: 'perm-owner' },
      { id: uuidv7(), documentId: docB, userId: 'perm-both', role: 'commenter', grantedBy: 'perm-owner' },
    ]);
    const roles = await loadCollaboratorRoles([docA, docB, docC], 'perm-both');
    expect(roles.get(docA)).toBe('editor');
    expect(roles.get(docB)).toBe('commenter');
    expect(roles.has(docC)).toBe(false);
  });

  it('returns an empty map when the id list is empty', async () => {
    const roles = await loadCollaboratorRoles([], 'perm-owner');
    expect(roles.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test permissions.test
```

Expected: the new tests fail with `loadCollaboratorRole is not a function` (or an import error).

- [ ] **Step 3: Implement the DB helpers**

Append to `apps/api/src/lib/permissions.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documentCollaborators } from '@primer/shared/schema';

export async function loadCollaboratorRole(
  docId: string,
  userId: string,
): Promise<CollaboratorRole | null> {
  const [row] = await db
    .select({ role: documentCollaborators.role })
    .from(documentCollaborators)
    .where(
      and(
        eq(documentCollaborators.documentId, docId),
        eq(documentCollaborators.userId, userId),
      ),
    )
    .limit(1);
  return (row?.role as CollaboratorRole | undefined) ?? null;
}

export async function loadCollaboratorRoles(
  docIds: string[],
  userId: string,
): Promise<Map<string, CollaboratorRole>> {
  const out = new Map<string, CollaboratorRole>();
  if (docIds.length === 0) return out;
  const rows = await db
    .select({
      documentId: documentCollaborators.documentId,
      role: documentCollaborators.role,
    })
    .from(documentCollaborators)
    .where(
      and(
        eq(documentCollaborators.userId, userId),
        inArray(documentCollaborators.documentId, docIds),
      ),
    );
  for (const r of rows) out.set(r.documentId, r.role as CollaboratorRole);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @primer/api test permissions.test
```

Expected: all permission tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/permissions.ts apps/api/src/lib/permissions.test.ts
git commit -m "$(cat <<'EOF'
feat(permissions): add loadCollaboratorRole + bulk variant

DB helpers for per-doc and per-user-across-many-docs collaborator role
lookup. Bulk variant will feed list-surface filters (dashboard, MCP
lists) once wire-through lands.

Refs #39
EOF
)"
```

---

### Task 4: Wire `apps/api/src/routes/documents.ts` through the permission helpers

**Files:**
- Modify: `apps/api/src/routes/documents.ts` (6 handlers: GET, PATCH, DELETE, restore, GET versions, POST version)
- Modify: `apps/api/src/routes/documents.test.ts` (extend for collab scenarios)

**Interfaces:**
- Consumes: `effectiveRole`, `canRead`, `canEdit`, `canManage`, `loadCollaboratorRole` from `../lib/permissions.ts`
- Produces: same DTOs as today; error codes and status codes preserved for existing test coverage

**Canonical route pattern** (used identically in every handler that fetches a doc row):

```ts
import {
  canRead, canEdit, canManage, effectiveRole, loadCollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

// ... inside a handler:
const [existing] = await db
  .select({
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    deletedAt: documents.deletedAt,
  })
  .from(documents)
  .where(eq(documents.id, docId));
if (!existing) return c.json({ error: 'not_found' }, 404);
if (existing.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

const collabRole = await loadCollaboratorRole(docId, user.id);
const eff = effectiveRole(existing, user.id, collabRole);

if (!canRead(existing.visibility as Visibility, eff)) {
  return c.json({ error: 'not_found' }, 404);   // privacy-preserving on reads
}
// For write endpoints, also check the write-shape:
if (!canEdit(eff))    return c.json({ error: 'forbidden' }, 403);
if (!canManage(eff))  return c.json({ error: 'forbidden' }, 403);
```

- [ ] **Step 1: Write the new failing tests (collab scenarios)**

Append to `apps/api/src/routes/documents.test.ts` a new `describe` block. Use the `mockMultiResolver` pattern from `crossUser.test.ts`:

```ts
import { mockMultiResolver } from '../auth/resolver.ts';
import { asUser, asUserJson } from '../test/harness.ts';
import { documentCollaborators } from '@primer/shared/schema';

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-docs-multi-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('doc access under visibility + collaborators', () => {
  it('GET private doc as non-collab returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);          // owned by mock-user-1
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(404);
    });
  });

  it('GET private doc as commenter collab returns 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(200);
    });
  });

  it('POST version as editor collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>v2</h1></body></html>'], { type: 'text/html' }), 'v2.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(201);
    });
  });

  it('POST version as commenter collab returns 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(403);
    });
  });

  it('DELETE as editor collab returns 403 (manage is owner-only)', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'DELETE',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test documents.test
```

Expected: the new tests fail (visibility flip is a no-op today because reads don't check it; POST version returns 403 for editor collab because inline check requires uploaderId match).

- [ ] **Step 3: Rewrite `GET /api/documents/:docId` to use helpers**

In `apps/api/src/routes/documents.ts`, extend the initial select to include `visibility`, then gate the read + the view-record on `canRead`:

```ts
const docRows = await db
  .select({
    id: documents.id,
    title: documents.title,
    description: documents.description,
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    createdAt: documents.createdAt,
    deletedAt: documents.deletedAt,
    uploaderDisplayName: users.displayName,
  })
  .from(documents)
  .innerJoin(users, eq(users.id, documents.uploaderId))
  .where(eq(documents.id, docId))
  .limit(1);

if (docRows.length === 0) return c.json({ error: 'not_found' }, 404);
if (docRows[0].deletedAt !== null) return c.json({ error: 'not_found' }, 404);

const user = c.get('user');
const collabRole = await loadCollaboratorRole(docId, user.id);
const eff = effectiveRole(docRows[0], user.id, collabRole);
if (!canRead(docRows[0].visibility as Visibility, eff)) {
  return c.json({ error: 'not_found' }, 404);
}
// ... rest of the handler unchanged, EXCEPT: the document_views upsert
// must only run when canRead passed (it already does — it's after the gate).
```

Move the imports to the top of the file:

```ts
import {
  canRead, canEdit, canManage, effectiveRole, loadCollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';
```

- [ ] **Step 4: Rewrite `PATCH /api/documents/:docId`**

Replace the existing block:

```ts
const [existing] = await db
  .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
  .from(documents)
  .where(eq(documents.id, docId));
if (!existing) return c.json({ error: 'not_found' }, 404);
if (existing.deletedAt !== null) return c.json({ error: 'not_found' }, 404);
if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);
```

with the canonical pattern using `canEdit` (see the top of Task 4). Response shape is unchanged. Errors: 404 when soft-deleted or unreadable-private; 403 when readable but not editable.

- [ ] **Step 5: Rewrite `DELETE /api/documents/:docId` and `POST /api/documents/:docId/restore`**

Both are owner-only ⇒ `canManage`. Replace the inline `if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);` in each handler with the canonical pattern using `canManage(eff)` for the gate. Fetch `visibility` in the select alongside `uploaderId` + `deletedAt`.

- [ ] **Step 6: Rewrite `GET /api/documents/:docId/versions`**

This handler currently only checks `deletedAt`. Extend the select to include `visibility` + `uploaderId`; load `collabRole`; gate on `canRead`. On failure return `{ error: 'not_found' }`, 404.

- [ ] **Step 7: Rewrite `POST /api/documents/:docId/versions`**

Replace the inline uploader check with the canonical pattern using `canEdit`. This is the write path — 404 when unreadable, 403 when readable but not editable.

- [ ] **Step 8: Run the tests**

Run:
```bash
pnpm --filter @primer/api test documents.test
```

Expected: all tests pass (new tests + existing tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): route documents.ts through permission helpers

GET/PATCH/DELETE/restore + list/add-version now gate on canRead/
canEdit/canManage instead of inline uploaderId checks. Behavior parity
under default org visibility; editors can add versions and edit
metadata under both visibility states; commenters can read private
docs; strangers 404 on private docs.

Refs #39
EOF
)"
```

---

### Task 5: Wire `versions.ts` PATCH + `versionContent.ts` GET

**Files:**
- Modify: `apps/api/src/routes/versions.ts`
- Modify: `apps/api/src/routes/versionContent.ts`
- Modify: `apps/api/src/routes/versions.test.ts`
- Modify: `apps/api/src/routes/versionContent.test.ts`

**Interfaces:**
- Consumes: helpers from `../lib/permissions.ts`
- Produces: unchanged DTOs and error codes

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/routes/versions.test.ts`:

```ts
import { mockMultiResolver } from '../auth/resolver.ts';
import { asUser, asUserJson } from '../test/harness.ts';
import { documentCollaborators, documents } from '@primer/shared/schema';

// helper reusing the same multi-user pattern as documents.test.ts
async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-versions-multi-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('PATCH /api/versions/:versionId under visibility + collab', () => {
  it('editor collab can edit version note', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'from editor' }),
      });
      expect(res.status).toBe(200);
    });
  });

  it('commenter collab cannot edit version note', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'nope' }),
      });
      expect(res.status).toBe(403);
    });
  });
});
```

Append to `apps/api/src/routes/versionContent.test.ts` (mirror the multi-user helper if not already present):

```ts
describe('GET /api/versions/:versionId/content under visibility + collab', () => {
  it('private doc + non-collab: 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/content`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });

  it('private doc + commenter collab: 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}/content`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test versions.test versionContent.test
```

Expected: new tests fail.

- [ ] **Step 3: Wire `PATCH /api/versions/:versionId`**

In `apps/api/src/routes/versions.ts`, extend the JOIN to fetch `visibility`, then replace the inline uploader check with the canonical pattern:

```ts
const [row] = await db
  .select({
    versionId: versions.id,
    documentId: versions.documentId,
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    docDeletedAt: documents.deletedAt,
  })
  .from(versions)
  .innerJoin(documents, eq(documents.id, versions.documentId))
  .where(eq(versions.id, versionId));
if (!row) return c.json({ error: 'not_found' }, 404);
if (row.docDeletedAt !== null) return c.json({ error: 'not_found' }, 404);

const collabRole = await loadCollaboratorRole(row.documentId, user.id);
const eff = effectiveRole(
  { uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
  user.id,
  collabRole,
);
if (!canRead(row.visibility as Visibility, eff)) return c.json({ error: 'not_found' }, 404);
if (!canEdit(eff)) return c.json({ error: 'forbidden' }, 403);
```

- [ ] **Step 4: Wire `GET /api/versions/:versionId/content`**

In `apps/api/src/routes/versionContent.ts`, extend the initial SQL to project `uploader_id` + `visibility`, then gate on `canRead`. The result of the gate is 404 (privacy-preserving) — same as the existing soft-delete branch:

```ts
const [versionWithDoc] = (await db.execute(sql`
  SELECT v.storage_key AS "storageKey",
         d.uploader_id  AS "uploaderId",
         d.visibility   AS "visibility",
         d.deleted_at   AS "deletedAt",
         d.id           AS "documentId"
  FROM versions v
  INNER JOIN documents d ON d.id = v.document_id
  WHERE v.id = ${versionId}
  LIMIT 1
`)) as unknown as {
  storageKey: string;
  uploaderId: string;
  visibility: Visibility;
  deletedAt: Date | null;
  documentId: string;
}[];
if (!versionWithDoc || versionWithDoc.deletedAt !== null) {
  return c.json({ error: 'not_found' }, 404);
}

const user = c.get('user');
const collabRole = await loadCollaboratorRole(versionWithDoc.documentId, user.id);
const eff = effectiveRole(versionWithDoc, user.id, collabRole);
if (!canRead(versionWithDoc.visibility, eff)) {
  return c.json({ error: 'not_found' }, 404);
}

const rows = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
// ... rest unchanged (build the streaming Response)
```

- [ ] **Step 5: Run the tests**

Run:
```bash
pnpm --filter @primer/api test versions.test versionContent.test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/versions.ts apps/api/src/routes/versionContent.ts \
        apps/api/src/routes/versions.test.ts apps/api/src/routes/versionContent.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): gate version note edit + content read on permissions

PATCH /api/versions/:id now canEdit (owner + editor collabs).
GET /api/versions/:id/content now canRead (owner + all collabs under
private; everyone under org). Preserves 404 for privacy on unreadable
private docs.

Refs #39
EOF
)"
```

---

### Task 6: Wire `threads.ts` (list, create, resolve, reopen)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

**Interfaces:**
- Consumes: helpers from `../lib/permissions.ts`
- Produces: unchanged DTOs; resolve/reopen preserve the existing "uploader OR first-comment author" rule, layered on top of `canRead`

**Key policy for resolve/reopen:** the existing `authorizeThreadMutation` (uploader OR first-comment author) stays. This task adds `canRead` as a *prerequisite* — if you can't read the parent doc (e.g., you were removed from a private doc's collaborators), you can't resolve/reopen either.

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
describe('threads under visibility + collab', () => {
  it('GET threads on private doc as non-collab returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });

  it('POST thread on private doc as commenter collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hey',
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('POST thread on private doc as stranger returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hey',
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test threads.test
```

Expected: new tests fail.

- [ ] **Step 3: Extend `ensureLiveDocumentForVersion` to return visibility + uploader + docId**

Currently `ensureLiveDocumentForVersion(versionId)` returns just `{ ok: true }` / `{ ok: false }`. Replace it with:

```ts
async function loadDocContextForVersion(
  versionId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId",
           d.uploader_id AS "uploaderId",
           d.visibility   AS "visibility",
           d.deleted_at   AS "deletedAt"
    FROM versions v
    INNER JOIN documents d ON d.id = v.document_id
    WHERE v.id = ${versionId}
    LIMIT 1
  `)) as unknown as {
    docId: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!r) return { ok: false };
  if (r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}
```

Do the same for `ensureLiveDocumentForThread`:

```ts
async function loadDocContextForThread(
  threadId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId",
           d.uploader_id AS "uploaderId",
           d.visibility   AS "visibility",
           d.deleted_at   AS "deletedAt"
    FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as {
    docId: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!r) return { ok: false };
  if (r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}
```

- [ ] **Step 4: Update handlers**

In each thread handler, replace `ensureLiveDocumentForVersion(versionId)` / `ensureLiveDocumentForThread(threadId)` with `loadDocContextForVersion` / `loadDocContextForThread` and add the canonical `canRead` / `canComment` gates:

```ts
// GET /api/versions/:versionId/threads
const ctx = await loadDocContextForVersion(versionId);
if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
const user = c.get('user');
const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
const eff = effectiveRole(ctx, user.id, collabRole);
if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
// ... rest unchanged
```

```ts
// POST /api/versions/:versionId/threads
const ctx = await loadDocContextForVersion(versionId);
if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
const user = c.get('user');
const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
const eff = effectiveRole(ctx, user.id, collabRole);
if (!canComment(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
// (canComment == canRead in this model, so a non-collab on private hits 404)
// ... rest unchanged
```

```ts
// POST /api/threads/:threadId/{resolve,reopen}
const ctx = await loadDocContextForThread(threadId);
if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
const user = c.get('user');
const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
const eff = effectiveRole(ctx, user.id, collabRole);
if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
// Keep the existing uploader-OR-first-author rule on top:
const authz = await authorizeThreadMutation(threadId, user.id);
if (authz === 'not_found') return c.json({ error: 'not_found' }, 404);
if (authz === 'forbidden') return c.json({ error: 'forbidden' }, 403);
// ... rest unchanged
```

- [ ] **Step 5: Run the tests**

Run:
```bash
pnpm --filter @primer/api test threads.test
```

Expected: all tests pass (new + existing).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/threads.ts apps/api/src/routes/threads.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): gate thread routes on canRead/canComment

Thread list/create + resolve/reopen now require canRead against the
parent doc. Create additionally requires canComment. Existing
uploader-OR-first-author rule for resolve/reopen is preserved on top.

Refs #39
EOF
)"
```

---

### Task 7: Wire `comments.ts` (create, PATCH, DELETE)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`
- Modify: `apps/api/src/routes/comments.test.ts`

**Interfaces:**
- Consumes: helpers from `../lib/permissions.ts`
- Produces: unchanged DTOs; author-only for PATCH/DELETE preserved

**Policy:** `POST /api/threads/:threadId/comments` requires `canComment`. `PATCH` and `DELETE` on `/api/comments/:commentId` are author-only (unchanged) plus require `canRead` on the parent doc (a removed collaborator loses the ability to touch old comments).

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/routes/comments.test.ts`:

```ts
describe('comment routes under visibility + collab', () => {
  it('POST reply on private doc as stranger returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      // owner creates a thread
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'seed',
        }),
      });
      const { id: threadId } = (await createRes.json()) as { id: string };
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ body: 'sneak' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('POST reply on private doc as commenter collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'seed',
        }),
      });
      const { id: threadId } = (await createRes.json()) as { id: string };
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ body: 'hey' }),
      });
      expect(res.status).toBe(201);
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test comments.test
```

Expected: new tests fail.

- [ ] **Step 3: Extend the thread-context loader in `comments.ts`**

Replace `ensureLiveDocumentForThread(threadId)` and `ensureLiveDocumentForComment(commentId)` with variants that return `docId`/`uploaderId`/`visibility` — same pattern as Task 6:

```ts
async function loadDocContextForThread(
  threadId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId", d.uploader_id AS "uploaderId",
           d.visibility AS "visibility", d.deleted_at AS "deletedAt"
    FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as {
    docId: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null;
  }[];
  if (!r || r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}

async function loadDocContextForComment(
  commentId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId", d.uploader_id AS "uploaderId",
           d.visibility AS "visibility", d.deleted_at AS "deletedAt"
    FROM comments c
    INNER JOIN threads t ON t.id = c.thread_id
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE c.id = ${commentId}
    LIMIT 1
  `)) as unknown as {
    docId: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null;
  }[];
  if (!r || r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}
```

- [ ] **Step 4: Update handlers**

```ts
// POST /api/threads/:threadId/comments
const ctx = await loadDocContextForThread(threadId);
if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
const user = c.get('user');
const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
const eff = effectiveRole(ctx, user.id, collabRole);
if (!canComment(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
// ... rest unchanged
```

```ts
// PATCH /api/comments/:commentId
const ctx = await loadDocContextForComment(commentId);
if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
const user = c.get('user');
const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
const eff = effectiveRole(ctx, user.id, collabRole);
if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
// existing author-only check stays exactly as-is
```

Same edit for `DELETE /api/comments/:commentId`.

- [ ] **Step 5: Run the tests**

Run:
```bash
pnpm --filter @primer/api test comments.test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/comments.ts apps/api/src/routes/comments.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): gate comment routes on canRead/canComment

Comment create requires canComment. Comment PATCH/DELETE require
canRead (author-only rule preserved on top). Ensures a user removed
from a private doc's collaborators can no longer touch their own old
comments.

Refs #39
EOF
)"
```

---

### Task 8: Filter `/api/dashboard` "Recently viewed or commented" by canRead

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts`
- Modify: `apps/api/src/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: no permissions module — the filter lives in SQL
- Produces: unchanged DashboardResponse shape; only content is filtered

**Policy:** the "My documents" list already filters `uploader_id = ${userId}` so it's unaffected. The "Recently viewed or commented" list must exclude rows where `documents.visibility = 'private'` AND `documents.uploader_id != ${userId}` AND there is no `document_collaborators` row for `(document_id, userId)`. This is a single extra `WHERE` predicate in the query. "Recently deleted" is already scoped to `uploader_id`.

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/routes/dashboard.test.ts`:

```ts
describe('dashboard filters private docs the user cannot read', () => {
  it('excludes private docs from "Recently viewed or commented" for non-collab', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);          // owned by mock-user-1
      // mock-user-2 views the doc while it's still org-visible
      const viewRes = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(viewRes.status).toBe(200);
      // owner flips to private
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request('/api/dashboard', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as { recentlyViewedOrCommented: Array<{ id: string }> };
      expect(body.recentlyViewedOrCommented.find((r) => r.id === upload.documentId)).toBeUndefined();
    });
  });

  it('includes private docs where the user has a collab row', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const viewRes = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(viewRes.status).toBe(200);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request('/api/dashboard', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as { recentlyViewedOrCommented: Array<{ id: string }> };
      expect(body.recentlyViewedOrCommented.find((r) => r.id === upload.documentId)).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test dashboard.test
```

Expected: the first new test fails (private doc still visible to non-collab).

- [ ] **Step 3: Add the visibility filter to the "Recently viewed or commented" SQL**

In `apps/api/src/routes/dashboard.ts`, extend the `latest`-joined SELECT so it excludes private docs the user can't read. The predicate lives inside the SQL where the docs are joined; add one `AND` clause:

```ts
// ── Recently viewed or commented ───────────────────────────
const activityResult = (await db.execute(sql`
  WITH viewed AS (
    SELECT dv.document_id, dv.viewed_at AS signal_at, 'viewed'::text AS signal
    FROM document_views dv
    WHERE dv.user_id = ${userId}
      AND dv.viewed_at > now() - interval '30 days'
  ),
  commented AS (
    SELECT v.document_id, MAX(c.created_at) AS signal_at, 'commented'::text AS signal
    FROM comments c
    INNER JOIN threads t ON t.id = c.thread_id
    INNER JOIN versions v ON v.id = t.version_id
    WHERE c.author_id = ${userId}
      AND c.created_at > now() - interval '30 days'
    GROUP BY v.document_id
  ),
  unioned AS (
    SELECT document_id, signal_at, signal FROM viewed
    UNION ALL
    SELECT document_id, signal_at, signal FROM commented
  ),
  latest AS (
    SELECT document_id,
           MAX(signal_at) AS signal_at,
           (ARRAY_AGG(signal ORDER BY signal_at DESC, signal DESC))[1] AS signal
    FROM unioned
    GROUP BY document_id
  )
  SELECT
    d.id,
    d.title,
    d.description,
    u.display_name AS "uploaderDisplayName",
    COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL)::int AS "threadCount",
    COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL AND t.resolved_at IS NULL)::int AS "activeThreadCount",
    latest.signal_at AS "lastActivityAt",
    latest.signal::text AS signal,
    latest.signal_at AS "signalAt"
  FROM latest
  INNER JOIN documents d ON d.id = latest.document_id AND d.deleted_at IS NULL
  INNER JOIN users u ON u.id = d.uploader_id
  LEFT JOIN versions v ON v.document_id = d.id
  LEFT JOIN threads t ON t.version_id = v.id
  WHERE
    d.visibility = 'org'
    OR d.uploader_id = ${userId}
    OR EXISTS (
      SELECT 1 FROM document_collaborators dc
      WHERE dc.document_id = d.id AND dc.user_id = ${userId}
    )
  GROUP BY d.id, d.title, d.description, u.display_name, latest.signal_at, latest.signal
  ORDER BY latest.signal_at DESC
`)) as unknown as ActivityRow[];
```

The `WHERE` clause is the only addition; the SELECT/JOIN shape is unchanged.

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @primer/api test dashboard.test
```

Expected: both new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/routes/dashboard.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): filter recently-viewed-or-commented by canRead

Private docs the current user neither owns nor collaborates on are
excluded from the home page activity list. Owner-owned lists are
already scoped to uploader_id and unaffected.

Refs #39
EOF
)"
```

---

### Task 9: Wire MCP tools (get_document / get_version_content / list_versions / get_comments / add_version)

**Files:**
- Modify: `apps/api/src/mcp/tools.ts`
- Modify: `apps/api/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: helpers from `../lib/permissions.ts`
- Produces: same tool return shapes; failure code `'not_found'` for `canRead=false`, `'forbidden'` for `canRead=true` but `canEdit=false`

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/mcp/tools.test.ts`:

```ts
import { documents, documentCollaborators } from '@primer/shared/schema';
import { v7 as uuidv7 } from 'uuid';

async function seedDocOwnedBy(ownerId: string): Promise<{ docId: string; versionId: string }> {
  const docId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: docId,
    title: 'X',
    description: null,
    uploaderId: ownerId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId: docId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  return { docId, versionId };
}

describe('MCP tools respect visibility + collab', () => {
  it('primer_get_document on private doc as stranger returns not_found', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document(
        { documentId: docId },
        { id: 'tools-stranger', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('primer_get_document on private doc as commenter returns ok', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-commenter');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-commenter',
      role: 'commenter', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document(
        { documentId: docId },
        { id: 'tools-commenter', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBeFalsy();
    });
  });

  it('primer_add_version as editor collab returns ok', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-editor');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-editor',
      role: 'editor', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_add_version(
        { documentId: docId, content: '<html><body>x</body></html>', format: 'html' },
        { id: 'tools-editor', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBeFalsy();
    });
  });

  it('primer_add_version as commenter collab returns forbidden', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-commenter');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-commenter',
      role: 'commenter', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_add_version(
        { documentId: docId, content: '<html><body>x</body></html>', format: 'html' },
        { id: 'tools-commenter', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('forbidden');
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
pnpm --filter @primer/api test mcp/tools.test
```

Expected: new tests fail.

- [ ] **Step 3: Wire `primer_get_document`**

At the top of `apps/api/src/mcp/tools.ts` add:

```ts
import {
  canRead, canEdit, effectiveRole, loadCollaboratorRole, type Visibility,
} from '../lib/permissions.ts';
```

Update the tool. The current select doesn't pull `visibility`; add it and gate on `canRead`:

```ts
const docRows = await db
  .select({
    id: documents.id,
    title: documents.title,
    description: documents.description,
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    createdAt: documents.createdAt,
    deletedAt: documents.deletedAt,
    uploaderDisplayName: users.displayName,
  })
  .from(documents)
  .innerJoin(users, eq(users.id, documents.uploaderId))
  .where(eq(documents.id, documentId))
  .limit(1);

if (docRows.length === 0) return err('not_found', 'document not found');
if (docRows[0].deletedAt !== null) return err('not_found', 'document not found');

const collabRole = await loadCollaboratorRole(documentId, user.id);
const eff = effectiveRole(docRows[0], user.id, collabRole);
if (!canRead(docRows[0].visibility as Visibility, eff)) {
  return err('not_found', 'document not found');
}
// ... rest unchanged
```

Note: change the handler signature so `user` is a real parameter, not `_user`. The existing handler uses `_user`; rename to `user`.

- [ ] **Step 4: Wire `primer_get_version_content`**

The tool resolves either via `versionId`, `documentId`, or `url`. After it has `documentId` (either from args or from resolving the version), add the same canonical block:

```ts
// After the version-resolution branches, before the storage.get():
const [docRow] = await db
  .select({ uploaderId: documents.uploaderId, visibility: documents.visibility })
  .from(documents)
  .where(eq(documents.id, row.documentId));
if (!docRow) return err('not_found', 'document not found');
const collabRole = await loadCollaboratorRole(row.documentId, user.id);
const eff = effectiveRole(docRow, user.id, collabRole);
if (!canRead(docRow.visibility as Visibility, eff)) {
  return err('not_found', 'version not found');
}
```

Rename `_user` → `user` on the handler signature.

- [ ] **Step 5: Wire `primer_list_versions`**

Extend the initial `existingDoc` select to include `uploaderId` + `visibility`, then gate:

```ts
const [existingDoc] = await db
  .select({
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    deletedAt: documents.deletedAt,
  })
  .from(documents)
  .where(eq(documents.id, documentId));
if (!existingDoc) return err('not_found', 'document not found');
if (existingDoc.deletedAt !== null) return err('not_found', 'document not found');

const collabRole = await loadCollaboratorRole(documentId, user.id);
const eff = effectiveRole(existingDoc, user.id, collabRole);
if (!canRead(existingDoc.visibility as Visibility, eff)) {
  return err('not_found', 'document not found');
}
```

Rename `_user` → `user`.

- [ ] **Step 6: Wire `primer_get_comments`**

After the branch that resolves `versionId` from `documentId` (or takes `versionId` directly), look up the parent doc's visibility + uploader before returning threads:

```ts
// Load the doc-of-record for permission gate. If we came in via documentId, we
// already have `docTitle`; otherwise we haven't touched documents yet.
const [docRow] = (await db.execute(sql`
  SELECT d.id AS "documentId", d.uploader_id AS "uploaderId", d.visibility AS "visibility"
  FROM versions v
  INNER JOIN documents d ON d.id = v.document_id
  WHERE v.id = ${versionId}
  LIMIT 1
`)) as unknown as {
  documentId: string; uploaderId: string; visibility: Visibility;
}[];
if (!docRow) return err('not_found', 'version not found');

const collabRole = await loadCollaboratorRole(docRow.documentId, user.id);
const eff = effectiveRole(docRow, user.id, collabRole);
if (!canRead(docRow.visibility, eff)) {
  return err('not_found', 'version not found');
}
```

Rename `_user` → `user`.

- [ ] **Step 7: Wire `primer_add_version`**

Replace the inline `if (existingDoc.uploaderId !== user.id) return err(...)` with the canonical write pattern:

```ts
const [existingDoc] = await db
  .select({
    uploaderId: documents.uploaderId,
    visibility: documents.visibility,
    deletedAt: documents.deletedAt,
  })
  .from(documents)
  .where(eq(documents.id, documentId));
if (!existingDoc) return err('not_found', 'document not found');
if (existingDoc.deletedAt !== null) return err('not_found', 'document not found');

const collabRole = await loadCollaboratorRole(documentId, user.id);
const eff = effectiveRole(existingDoc, user.id, collabRole);
if (!canRead(existingDoc.visibility as Visibility, eff)) {
  return err('not_found', 'document not found');
}
if (!canEdit(eff)) {
  return err('forbidden', 'only the document owner or editor collaborators can add versions');
}
```

- [ ] **Step 8: Run the tests**

Run:
```bash
pnpm --filter @primer/api test mcp/tools.test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/mcp/tools.ts apps/api/src/mcp/tools.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): gate primer_* tools on permission helpers

primer_get_document / primer_get_version_content / primer_list_versions
/ primer_get_comments require canRead. primer_add_version requires
canEdit. Failure codes mirror the HTTP layer (not_found vs forbidden).

Refs #39
EOF
)"
```

---

### Task 10: End-to-end cross-user integration test with collaborators

**Files:**
- Modify: `apps/api/src/test/crossUser.test.ts`

**Interfaces:**
- Consumes: everything wired above; the multi-user harness pattern already lives in this file
- Produces: a single high-level scenario that walks a real doc through org/private with editor + commenter collaborators end to end

- [ ] **Step 1: Add the scenario**

Append to `apps/api/src/test/crossUser.test.ts`:

```ts
import { documentCollaborators } from '@primer/shared/schema';

describe('collaborators × visibility — end-to-end', () => {
  it('editor can add a version to a private doc; commenter cannot; stranger 404s', async () => {
    await withMultiUserApp(async (app) => {
      // owner = mock-user-1 uploads
      const upload = await uploadFixture(app);
      // add mock-user-2 as editor, seed a third user as commenter, leave a fourth as stranger
      await db.insert(users).values([
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
        { id: 'mock-user-4', email: 'four@p.t', displayName: 'User Four' },
      ]).onConflictDoNothing();
      await db.insert(documentCollaborators).values([
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-2',
          role: 'editor',
          grantedBy: 'mock-user-1',
        },
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-3',
          role: 'commenter',
          grantedBy: 'mock-user-1',
        },
      ]);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));

      // editor: can read + add version
      const readAsEditor = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(readAsEditor.status).toBe(200);

      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>v2</h1></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsEditor = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(addAsEditor.status).toBe(201);

      // commenter: can read but cannot add a version
      const readAsCommenter = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-3'),
      });
      expect(readAsCommenter.status).toBe(200);

      const fd2 = new FormData();
      fd2.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsCommenter = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-3'),
        body: fd2,
      });
      expect(addAsCommenter.status).toBe(403);

      // stranger: 404 on read, 404 on write
      const readAsStranger = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-4'),
      });
      expect(readAsStranger.status).toBe(404);

      const fd3 = new FormData();
      fd3.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsStranger = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-4'),
        body: fd3,
      });
      expect(addAsStranger.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run:
```bash
pnpm --filter @primer/api test crossUser.test
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/crossUser.test.ts
git commit -m "$(cat <<'EOF'
test(crossUser): end-to-end scenario for collaborators + private doc

Owner + editor + commenter + stranger walked through a private doc:
editor can add a version, commenter reads but not writes, stranger
sees a 404. Belt-and-braces coverage over the wire-through in
Sub 1 of #29.

Refs #39
EOF
)"
```

---

### Task 11: Final verification — full suite + typecheck + branch push

**Files:** none (verification only)

**Interfaces:** all prior tasks integrated

- [ ] **Step 1: Full test suite**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: entire API test suite green.

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @primer/api typecheck
```

Expected: no errors.

- [ ] **Step 3: Web app typecheck (defensive — no web changes but the schema is a shared package)**

Run:
```bash
pnpm --filter @primer/web typecheck 2>/dev/null || echo "no web typecheck script (skip)"
```

Expected: no schema-related errors surface in the web app (the frontend doesn't read `documents.visibility` yet — that's Sub 3).

- [ ] **Step 4: Grep for stragglers**

Run:
```bash
grep -RIn "uploaderId !== user.id\|uploader_id !== user.id" apps/api/src/routes apps/api/src/mcp
```

Expected: no matches. Every inline owner check should have been replaced by the helpers.

- [ ] **Step 5: Push and open a draft PR**

Confirm you're on a feature branch named `issue-39-permission-core` (or whatever the executor-created branch is called). Then:

```bash
git push -u origin HEAD
gh pr create --draft --base master \
  --title "feat(collab): permission core (schema + helpers + wire-through)" \
  --body "$(cat <<'BODY'
Implements sub-issue #39 (Sub 1 of #29). See the design doc at
docs/superpowers/specs/2026-07-02-doc-collaborators-design.md
and the implementation plan at
docs/superpowers/plans/2026-07-02-doc-collaborators-permission-core.md.

## Summary
- Schema: `documents.visibility` + `document_collaborators` table (additive; defaults preserve today's behavior).
- Central `apps/api/src/lib/permissions.ts` with pure helpers + DB lookups.
- Every HTTP route + MCP tool listed in the spec now gates on the helpers.
- `/api/dashboard` "Recently viewed or commented" filters private docs the user can't read.
- End-to-end cross-user integration test walking owner/editor/commenter/stranger through a private doc.

Behavior-preserving on default (`visibility='org'` + empty collab table).

Closes #39
Refs #29
BODY
)"
```

Return the PR URL to the human reviewer.

## Self-review

Spec coverage:

- **Schema (visibility + collab table)** → Task 1. ✓
- **Central helpers** → Tasks 2–3. ✓
- **All HTTP routes wired** — GET/PATCH/DELETE/restore/list-versions/add-version (Task 4), PATCH version (Task 5), version content (Task 5), thread list/create/resolve/reopen (Task 6), comment create/PATCH/DELETE (Task 7). ✓
- **All MCP tools wired** — get_document / get_version_content / list_versions / get_comments (canRead), add_version (canEdit). Task 9. ✓
- **Dashboard "Recently viewed or commented" filtered** → Task 8. ✓
- **Unit tests for helpers covering the matrix** → Task 2. ✓
- **Integration tests confirming existing routes behave identically for default state** → covered by every existing test remaining green; explicit cross-user scenario in Task 10. ✓
- **Behavior parity on ship** → migration is additive with `'org'` default; empty collab table. ✓

Deferred (out of scope for Sub 1, tracked in later sub-issues):

- Collaborator management API + user typeahead → #40 (Sub 2).
- Notifier extension `notifyCollaboratorAdded` → #40 (Sub 2), attached to the add endpoint.
- Any UI, dashboard "Shared with me" section, or private badges → #41 / #42 (Subs 3/4).

Placeholder scan: none — every step has runnable commands / code / commit messages.

Type consistency: `EffectiveRole` and `CollaboratorRole` types are used identically across Tasks 2, 3, 4, 5, 6, 7, 9, 10. Helper names (`canRead` / `canComment` / `canEdit` / `canManage` / `effectiveRole` / `loadCollaboratorRole` / `loadCollaboratorRoles`) match between definition (Tasks 2–3) and consumers (Tasks 4–10).
