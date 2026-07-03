# Doc Collaborators — Sub 2: Management API + Typeahead + Notify-on-Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the HTTP surface that owners use to manage collaborators + visibility on their docs, plus the user typeahead endpoint the sharing modal will call, plus the one-time email that fires when a user is added as a collaborator.

**Architecture:** Additive HTTP surface on top of Sub 1's permission core. Four new endpoints under `/api/documents/:docId/collaborators/...` (list / add / remove / change role) live in a new `apps/api/src/routes/collaborators.ts`. `PATCH /api/documents/:docId` gains a body-dispatched `visibility` field (manage-only). A new `GET /api/users?q=…&docId=…` extends `apps/api/src/routes/users.ts`. The existing `Notifier` abstraction gains a `notifyCollaboratorAdded(...)` method; both `NoopNotifier` and `MailgunNotifier` implement it; the add endpoint fires it fire-and-forget after commit.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Postgres, Vitest (`environment: 'node'`), pnpm workspaces. Mailgun HTTP API (no SDK) for the notifier — matches the existing `notifyComment` transport shape.

**Spec:** `docs/superpowers/specs/2026-07-02-doc-collaborators-design.md` — Sub 2 section + Notifications section.
**Issue:** [#40 (Sub 2 of #29)](https://github.com/0xPolygon/primer/issues/40)
**Sub 1 depends-on:** [#39](https://github.com/0xPolygon/primer/issues/39) merged to `master` (or stacked on `issue-29-doc-collaborators-spec` while #38 is open).

## Global Constraints

- **pnpm only.** Never npm. Every install: `pnpm install`.
- Explicit `.ts` extensions on all TS imports.
- Vitest: `environment: 'node'`, `fileParallelism: false`, tests hit the real `primer_test` DB (`DATABASE_URL_TEST`). Do **not** mock the DB.
- **404 vs 403 policy** (from Sub 1 — same rules apply here): read paths return **404** on `canRead=false`; write paths return **404** on `canRead=false`, **403** on `canRead=true` but the write check fails. New management endpoints follow this — non-owner with read access gets 403; stranger on a private doc gets 404.
- **Role validation rules** (verbatim from the spec):
  - Owner cannot be added as their own collaborator → `400 owner_not_collaborator`.
  - Under `org` visibility, `commenter` role cannot be added → `400 invalid_role_for_visibility`.
  - Same `(document_id, user_id)` pair cannot appear twice → the DB unique constraint fires; the endpoint translates PG code `23505` to `409 collaborator_exists`.
  - Any role change or add hits `canManage` first — owner-only.
- **Notifier self-suppression** happens *inside* the notifier implementations (both NoopNotifier and MailgunNotifier), not at the call site. If `addedUserId === addedByUserId` the notifier returns without side effects. This centralizes the policy so future call sites can't forget it.
- **DTOs** live in `packages/shared/src/api.ts` alongside the existing ones.
- **`Refs #40` on every commit.**

## Deviations from the design doc (acknowledged)

- The spec references a `NotifierSpy` for tests. The repo already has a test pattern using `vi.stubGlobal('fetch', ...)` (see `apps/api/src/notifications/mailgun.test.ts`). For endpoint tests (which need to assert the notifier was called with specific args), this plan defines a small `SpyNotifier` local to the test file. It implements `Notifier` and records calls in-memory — no changes to the `Notifier` interface, no shared test helper.
- Sub 1's whole-branch review flagged three Minors ("bundle with Sub 2"): unused `asUserJson` import, redundant SELECT in `versionContent.ts`, and adding `document_collaborators` to the explicit `TRUNCATE` list. Task 1 bundles the last two as a single cleanup commit. The unused `asUserJson` import in `documents.test.ts` resolves organically once Task 4 re-uses it for PATCH visibility tests.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/src/routes/versionContent.ts` | Use `versionWithDoc.storageKey`, drop redundant SELECT | 1 |
| `apps/api/src/testing/setup.ts` | Add `document_collaborators` to explicit TRUNCATE list | 1 |
| `apps/api/src/notifications/notifier.ts` | Add `NotifyCollaboratorAddedArgs` + method on interface + `NoopNotifier` impl | 2 |
| `apps/api/src/notifications/notifier.test.ts` | NoopNotifier test for new method | 2 |
| `apps/api/src/notifications/mailgun.ts` | `notifyCollaboratorAdded` implementation + self-suppression | 2 |
| `apps/api/src/notifications/mailgun.test.ts` | Fetch-mocked tests for the new method | 2 |
| `packages/shared/src/api.ts` | New DTOs: `Collaborator`, `CollaboratorsListResponse`, `AddCollaboratorRequest`, `UpdateCollaboratorRequest`, `UserSearchResponse` | 3, 4, 5 |
| `apps/api/src/routes/collaborators.ts` | New file — 4 endpoints (list/add/patch/delete) + register | 3 |
| `apps/api/src/routes/collaborators.test.ts` | New file — integration tests + SpyNotifier | 3 |
| `apps/api/src/app.ts` | Register the new route module | 3 |
| `apps/api/src/routes/documents.ts` | Extend PATCH to accept `visibility` (body-dispatched) | 4 |
| `apps/api/src/routes/documents.test.ts` | New scenarios: owner sets visibility, editor cannot | 4 |
| `apps/api/src/routes/users.ts` | Add `GET /api/users` typeahead endpoint | 5 |
| `apps/api/src/routes/users.test.ts` | New file — typeahead tests | 5 |

Each task ends with an independently committable change.

---

### Task 1: Sub 1 cleanup (bundled follow-ups)

**Files:**
- Modify: `apps/api/src/routes/versionContent.ts` (drop redundant `db.select().from(versions)` after the gate)
- Modify: `apps/api/src/testing/setup.ts` (add `document_collaborators` to the TRUNCATE list)

**Interfaces:**
- Consumes: nothing new
- Produces: no new surface — cleanup only

Note on the "unused `asUserJson` import in documents.test.ts" finding from Sub 1's whole-branch review: skip that cleanup here — Task 4 adds PATCH tests that use `asUserJson('mock-user-1')`, so the import returns to used status naturally after Task 4 lands.

- [ ] **Step 1: Reuse `versionWithDoc.storageKey` in `versionContent.ts`**

In `apps/api/src/routes/versionContent.ts`, after the permission gate the current code re-selects from `versions` just to get `storageKey`. Since the initial raw SQL already returns `storageKey`, drop the second query. Replace:

```ts
const rows = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
if (rows.length === 0) {
  return c.json({ error: 'not_found' }, 404);
}

const stream = await deps.storage.get(rows[0].storageKey);
```

with:

```ts
const stream = await deps.storage.get(versionWithDoc.storageKey);
```

Also remove the now-unused `import { eq } from 'drizzle-orm';` and `import { versions } from '@primer/shared/schema';` from this file if no other reference remains.

- [ ] **Step 2: Add `document_collaborators` to the explicit TRUNCATE list**

In `apps/api/src/testing/setup.ts`, change the truncate line:

```ts
// Before
await sql`truncate table document_views, comments, threads, versions, documents restart identity cascade`;
// After
await sql`truncate table document_collaborators, document_views, comments, threads, versions, documents restart identity cascade`;
```

The `documents CASCADE` already covers `document_collaborators` via the FK; adding it explicitly makes the intent legible and survives future FK changes.

- [ ] **Step 3: Run the full API test suite**

```bash
pnpm --filter @primer/api test
```

Expected: still 503/503 green. Nothing behavioral changed.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @primer/api typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/versionContent.ts apps/api/src/testing/setup.ts
git commit -m "$(cat <<'EOF'
chore(collab): follow-ups from Sub 1 whole-branch review

- Reuse versionWithDoc.storageKey in versionContent.ts, dropping a
  redundant post-gate SELECT (one fewer round-trip per artifact load).
- Add document_collaborators to the explicit TRUNCATE list in the test
  setup for legibility (FK CASCADE already covered it).

The Sub 1 review's third minor (unused asUserJson import) is resolved
organically by Task 4, which re-uses it for PATCH visibility tests.

Refs #40
EOF
)"
```

---

### Task 2: Extend `Notifier` interface with `notifyCollaboratorAdded`

**Files:**
- Modify: `apps/api/src/notifications/notifier.ts` (add args interface + method + NoopNotifier impl)
- Modify: `apps/api/src/notifications/notifier.test.ts` (new NoopNotifier test)
- Modify: `apps/api/src/notifications/mailgun.ts` (add method + rendering + self-suppression)
- Modify: `apps/api/src/notifications/mailgun.test.ts` (new fetch-mocked tests)

**Interfaces:**
- Consumes: existing `Notifier` interface (`notifyComment`), existing `MailgunNotifier` config, existing `users` schema
- Produces:
  - `NotifyCollaboratorAddedArgs { docId, docTitle, addedUserId, addedByUserId, role }`
  - `Notifier.notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void>`
  - Self-suppression: if `args.addedUserId === args.addedByUserId`, return without side effects (in both NoopNotifier and MailgunNotifier)

- [ ] **Step 1: Write failing NoopNotifier test**

Append to `apps/api/src/notifications/notifier.test.ts`:

```ts
import type { NotifyCollaboratorAddedArgs } from './notifier.ts';

const COLLAB_ARGS: NotifyCollaboratorAddedArgs = {
  docId: 'doc-1',
  docTitle: 'Test Doc',
  addedUserId: 'mock-user-2',
  addedByUserId: 'mock-user-1',
  role: 'editor',
};

describe('NoopNotifier.notifyCollaboratorAdded', () => {
  it('resolves without error', async () => {
    const n = new NoopNotifier();
    await expect(n.notifyCollaboratorAdded(COLLAB_ARGS)).resolves.toBeUndefined();
  });

  it('resolves without error even on self-add (still a no-op)', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyCollaboratorAdded({ ...COLLAB_ARGS, addedUserId: COLLAB_ARGS.addedByUserId }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write failing MailgunNotifier tests**

Append to `apps/api/src/notifications/mailgun.test.ts`. Reuse the existing `fetchMock` + `beforeEach`/`afterEach` scaffolding, which seeds `mock-user-1` and `mock-user-2` and stubs `fetch`. Add:

```ts
import type { NotifyCollaboratorAddedArgs } from './notifier.ts';

function collabArgs(over: Partial<NotifyCollaboratorAddedArgs> = {}): NotifyCollaboratorAddedArgs {
  return {
    docId: 'doc-1',
    docTitle: 'Test Doc',
    addedUserId: 'mock-user-2',
    addedByUserId: 'mock-user-1',
    role: 'editor',
    ...over,
  };
}

describe('MailgunNotifier.notifyCollaboratorAdded', () => {
  it('POSTs a single email to the added user with subject and body', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/dashboard.polygon.technology/messages');
    const form = parseForm(String(init.body));
    expect(form.to).toBe('two@p.t');
    expect(form.subject).toBe(`You were added to 'Test Doc' on Primer`);
    expect(form.text).toContain('User One added you as an editor');
    expect(form.text).toContain('https://primer.example/d/doc-1');
    expect(form.html).toContain('User One');
    expect(form.html).toContain('added you as an <strong>editor</strong>');
    expect(form.html).toContain('href="https://primer.example/d/doc-1"');
  });

  it('renders commenter role text', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ role: 'commenter' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = parseForm(String(init.body));
    expect(form.text).toContain('User One added you as a commenter');
    expect(form.html).toContain('added you as a <strong>commenter</strong>');
  });

  it('suppresses self-add (no HTTP request)', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ addedUserId: 'mock-user-1' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips send if added user has no email row (logs and returns)', async () => {
    const n = new MailgunNotifier({
      apiKey: 'sk-test',
      domain: 'dashboard.polygon.technology',
      fromAddress: 'primer@dashboard.polygon.technology',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyCollaboratorAdded(collabArgs({ addedUserId: 'unknown-user-xyz' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the failing tests**

```bash
pnpm --filter @primer/api test notifications/
```

Expected: the 5 new tests fail — `notifyCollaboratorAdded is not a function` on both NoopNotifier and MailgunNotifier.

- [ ] **Step 4: Add args interface + method to `Notifier` + NoopNotifier**

In `apps/api/src/notifications/notifier.ts` add above the `Notifier` interface:

```ts
import type { CollaboratorRole } from '../lib/permissions.ts';

export interface NotifyCollaboratorAddedArgs {
  docId: string;
  docTitle: string;
  addedUserId: string;
  addedByUserId: string;
  role: CollaboratorRole;
}
```

Extend the `Notifier` interface:

```ts
export interface Notifier {
  notifyComment(args: NotifyCommentArgs): Promise<void>;
  notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void>;
}
```

Extend `NoopNotifier`:

```ts
export class NoopNotifier implements Notifier {
  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
    if (args.addedUserId === args.addedByUserId) return;
    logger.debug({ args }, 'notifyCollaboratorAdded (no-op)');
  }
}
```

- [ ] **Step 5: Add MailgunNotifier implementation**

In `apps/api/src/notifications/mailgun.ts` add a rendering helper block near the existing `renderSubject`/`renderText`/`renderHtml` for comments (keep them separate — the two notification types have different shapes):

```ts
function renderCollabSubject(docTitle: string): string {
  return `You were added to '${truncate(docTitle, SUBJECT_TITLE_LIMIT)}' on Primer`;
}

function renderCollabText(
  actorName: string,
  role: 'commenter' | 'editor',
  docTitle: string,
  url: string,
): string {
  const article = role === 'editor' ? 'an' : 'a';
  return [
    `${actorName} added you as ${article} ${role} on '${docTitle}'.`,
    '',
    `Open the doc: ${url}`,
    '',
    'You received this because you were added as a collaborator on this document.',
  ].join('\n');
}

function renderCollabHtml(
  actorName: string,
  role: 'commenter' | 'editor',
  docTitle: string,
  url: string,
): string {
  const safeActor = escapeHtml(actorName);
  const safeTitle = escapeHtml(docTitle);
  const article = role === 'editor' ? 'an' : 'a';
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">${safeActor} added you as ${article} <strong>${role}</strong> on '<strong style="color:#171717;">${safeTitle}</strong>'.</p>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open the doc</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were added as a collaborator on this document.</p>
  </td></tr>
</table>
</body></html>`;
}
```

Then extend the `MailgunNotifier` class with the new method:

```ts
async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
  if (args.addedUserId === args.addedByUserId) return;

  const rows = (await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, [args.addedUserId, args.addedByUserId]))) as UserRow[];
  const recipient = rows.find((u) => u.id === args.addedUserId);
  if (!recipient) {
    logger.warn({ addedUserId: args.addedUserId }, 'collab: added user not in users table, skipping');
    return;
  }
  const actor = rows.find((u) => u.id === args.addedByUserId);
  const actorName = actor?.displayName ?? 'Someone';

  const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.docId}`;
  const subject = renderCollabSubject(args.docTitle);
  const text = renderCollabText(actorName, args.role, args.docTitle, url);
  const html = renderCollabHtml(actorName, args.role, args.docTitle, url);

  const apiBase = (this.cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const endpoint = `${apiBase}/v3/${encodeURIComponent(this.cfg.domain)}/messages`;
  const authHeader = `Basic ${Buffer.from(`api:${this.cfg.apiKey}`).toString('base64')}`;

  const form = new URLSearchParams();
  form.set('from', this.cfg.fromAddress);
  form.set('to', recipient.email);
  form.set('subject', subject);
  form.set('text', text);
  form.set('html', html);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error(
        { status: res.status, addedUserId: args.addedUserId, errBody: errBody.slice(0, 300) },
        'mailgun collab-add send failed',
      );
    }
  } catch (err) {
    logger.error({ err, addedUserId: args.addedUserId }, 'mailgun collab-add fetch threw');
  }
}
```

Update the top-of-file imports if needed:

```ts
import type { Notifier, NotifyCommentArgs, NotifyCollaboratorAddedArgs } from './notifier.ts';
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @primer/api test notifications/
```

Expected: all notifier tests pass (previous + 5 new).

- [ ] **Step 7: Full suite**

```bash
pnpm --filter @primer/api test
```

Expected: green (previous 503 + new tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/notifications/
git commit -m "$(cat <<'EOF'
feat(notifier): add notifyCollaboratorAdded on Notifier + implementations

Extends the Notifier interface with a single-recipient email hook
for "user added as collaborator." NoopNotifier no-ops; MailgunNotifier
sends one email to the added user's address with role and doc link.
Self-suppression (addedUserId === addedByUserId) is enforced inside
each implementation so the policy holds regardless of call site.

Refs #40
EOF
)"
```

---

### Task 3: Collaborator management endpoints + notifier wiring + DTOs

**Files:**
- Create: `apps/api/src/routes/collaborators.ts`
- Create: `apps/api/src/routes/collaborators.test.ts`
- Modify: `apps/api/src/app.ts` (register the new route module)
- Modify: `packages/shared/src/api.ts` (add DTOs)

**Interfaces:**
- Consumes: `canManage`, `effectiveRole`, `loadCollaboratorRole` from `../lib/permissions.ts`; `documentCollaborators`, `documents`, `users` schema; `AppDeps.notifier`
- Produces:
  - `Collaborator { userId, displayName, role, grantedBy, createdAt }`
  - `CollaboratorsListResponse { collaborators: Collaborator[] }`
  - `AddCollaboratorRequest { userId, role }`
  - `UpdateCollaboratorRequest { role }`
  - `GET    /api/documents/:docId/collaborators`
  - `POST   /api/documents/:docId/collaborators`
  - `PATCH  /api/documents/:docId/collaborators/:userId`
  - `DELETE /api/documents/:docId/collaborators/:userId`

- [ ] **Step 1: Add DTOs to shared package**

Append to `packages/shared/src/api.ts`:

```ts
export interface Collaborator {
  userId: string;
  displayName: string;
  role: 'commenter' | 'editor';
  grantedBy: string;
  createdAt: string;
}

export interface CollaboratorsListResponse {
  collaborators: Collaborator[];
}

export interface AddCollaboratorRequest {
  userId: string;
  role: 'commenter' | 'editor';
}

export interface UpdateCollaboratorRequest {
  role: 'commenter' | 'editor';
}
```

- [ ] **Step 2: Write failing tests**

Create `apps/api/src/routes/collaborators.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, documentCollaborators, users } from '@primer/shared/schema';
import type { Notifier, NotifyCommentArgs, NotifyCollaboratorAddedArgs } from '../notifications/notifier.ts';
import type { Collaborator, CollaboratorsListResponse } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class SpyNotifier implements Notifier {
  collabCalls: NotifyCollaboratorAddedArgs[] = [];
  commentCalls: NotifyCommentArgs[] = [];
  async notifyComment(args: NotifyCommentArgs): Promise<void> { this.commentCalls.push(args); }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> { this.collabCalls.push(args); }
}

async function withMultiUserApp<T>(
  fn: (app: ReturnType<typeof createApp>, notifier: SpyNotifier) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-collabroutes-'));
  try {
    const notifier = new SpyNotifier();
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier,
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
      ])
      .onConflictDoNothing();
    return await fn(app, notifier);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/documents/:docId/collaborators', () => {
  it('owner: returns empty list initially', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollaboratorsListResponse;
      expect(body.collaborators).toEqual([]);
    });
  });

  it('non-owner (canRead but not canManage): 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(403);
    });
  });

  it('stranger on private doc: 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(404);
    });
  });

  it('returns rows with displayName joined', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollaboratorsListResponse;
      expect(body.collaborators).toHaveLength(1);
      expect(body.collaborators[0]).toMatchObject({
        userId: 'mock-user-2',
        displayName: 'User Two',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
    });
  });
});

describe('POST /api/documents/:docId/collaborators', () => {
  it('owner adds editor: 201 + calls notifier with exact args', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as Collaborator;
      expect(body).toMatchObject({
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
        displayName: 'User Two',
      });
      // Notifier fired exactly once with the right shape.
      expect(notifier.collabCalls).toHaveLength(1);
      expect(notifier.collabCalls[0]).toEqual({
        docId: upload.documentId,
        docTitle: 'Fixture',
        addedUserId: 'mock-user-2',
        addedByUserId: 'mock-user-1',
        role: 'editor',
      });
    });
  });

  it('non-owner: 403 and notifier not called', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-2'),
          body: JSON.stringify({ userId: 'mock-user-3', role: 'editor' }),
        },
      );
      expect(res.status).toBe(403);
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('owner_not_collaborator (400) when adding owner as their own collab', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-1', role: 'editor' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('owner_not_collaborator');
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('invalid_role_for_visibility (400) when adding commenter under org visibility', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'commenter' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_role_for_visibility');
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('commenter allowed under private visibility', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'commenter' }),
        },
      );
      expect(res.status).toBe(201);
    });
  });

  it('collaborator_exists (409) on duplicate add', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      // First add succeeds.
      const r1 = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(r1.status).toBe(201);
      // Second add of same (doc, user) fails on the unique constraint.
      const r2 = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { error: string }).error).toBe('collaborator_exists');
    });
  });

  it('invalid_body (400) on missing fields', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });
});

describe('PATCH /api/documents/:docId/collaborators/:userId', () => {
  it('owner changes role: 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'commenter', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'editor' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Collaborator;
      expect(body.role).toBe('editor');
    });
  });

  it('non-owner: 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-2'),
          body: JSON.stringify({ role: 'commenter' }),
        },
      );
      expect(res.status).toBe(403);
    });
  });

  it('invalid_role_for_visibility (400) when changing to commenter under org', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'commenter' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_role_for_visibility');
    });
  });

  it('not_found (404) when target userId has no collab row', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'editor' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });
});

describe('DELETE /api/documents/:docId/collaborators/:userId', () => {
  it('owner removes: 204', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentCollaborators).where(
        drizzleSql`document_id = ${upload.documentId} AND user_id = 'mock-user-2'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('non-owner: 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(403);
    });
  });

  it('idempotent: DELETE on already-absent row returns 204', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(204);
    });
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
pnpm --filter @primer/api test collaborators.test
```

Expected: fails — `collaborators.ts` doesn't exist; app has no `/api/documents/:docId/collaborators` route.

- [ ] **Step 4: Create the route module**

Create `apps/api/src/routes/collaborators.ts`:

```ts
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type {
  AddCollaboratorRequest,
  Collaborator,
  CollaboratorsListResponse,
  UpdateCollaboratorRequest,
} from '@primer/shared';
import { documents, documentCollaborators, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import {
  canManage,
  canRead,
  effectiveRole,
  loadCollaboratorRole,
  type CollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

async function loadDocForManage(
  docId: string,
  userId: string,
): Promise<
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'ok'; doc: { id: string; title: string; uploaderId: string; visibility: Visibility } }
> {
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!row) return { status: 'not_found' };
  if (row.deletedAt !== null) return { status: 'not_found' };

  const collabRole = await loadCollaboratorRole(docId, userId);
  const eff = effectiveRole(
    { uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
    userId,
    collabRole,
  );
  if (!canRead(row.visibility as Visibility, eff)) return { status: 'not_found' };
  if (!canManage(eff)) return { status: 'forbidden' };
  return {
    status: 'ok',
    doc: { id: row.id, title: row.title, uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
  };
}

function isRole(x: unknown): x is CollaboratorRole {
  return x === 'commenter' || x === 'editor';
}

export function registerCollaboratorRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.get('/api/documents/:docId/collaborators', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const rows = await db
      .select({
        userId: documentCollaborators.userId,
        role: documentCollaborators.role,
        grantedBy: documentCollaborators.grantedBy,
        createdAt: documentCollaborators.createdAt,
        displayName: users.displayName,
      })
      .from(documentCollaborators)
      .innerJoin(users, eq(users.id, documentCollaborators.userId))
      .where(eq(documentCollaborators.documentId, docId))
      .orderBy(documentCollaborators.createdAt);

    const body: CollaboratorsListResponse = {
      collaborators: rows.map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        role: r.role as CollaboratorRole,
        grantedBy: r.grantedBy,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    return c.json(body, 200);
  });

  app.post('/api/documents/:docId/collaborators', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    let payload: Partial<AddCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<AddCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (typeof payload.userId !== 'string' || payload.userId.length === 0 || !isRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'userId (string) and role (commenter|editor) are required' }, 400);
    }
    const { userId: targetUserId, role } = payload;
    if (targetUserId === gate.doc.uploaderId) {
      return c.json({ error: 'owner_not_collaborator', message: 'Owner cannot be added as their own collaborator.' }, 400);
    }
    if (gate.doc.visibility === 'org' && role === 'commenter') {
      return c.json(
        { error: 'invalid_role_for_visibility', message: 'Commenter role is only meaningful under private visibility.' },
        400,
      );
    }
    const [target] = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) return c.json({ error: 'user_not_found', message: 'target user does not exist' }, 400);

    const id = uuidv7();
    const createdAt = new Date();
    try {
      await db.insert(documentCollaborators).values({
        id,
        documentId: docId,
        userId: targetUserId,
        role,
        grantedBy: user.id,
        createdAt,
      });
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return c.json({ error: 'collaborator_exists', message: 'that user is already a collaborator' }, 409);
      }
      throw err;
    }

    void deps.notifier
      .notifyCollaboratorAdded({
        docId,
        docTitle: gate.doc.title,
        addedUserId: targetUserId,
        addedByUserId: user.id,
        role,
      })
      .catch((err) => logger.error({ err, docId, addedUserId: targetUserId }, 'notifier notifyCollaboratorAdded failed'));

    const body: Collaborator = {
      userId: targetUserId,
      displayName: target.displayName,
      role,
      grantedBy: user.id,
      createdAt: createdAt.toISOString(),
    };
    return c.json(body, 201);
  });

  app.patch('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    let payload: Partial<UpdateCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<UpdateCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (!isRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'role (commenter|editor) is required' }, 400);
    }
    const { role } = payload;
    if (gate.doc.visibility === 'org' && role === 'commenter') {
      return c.json(
        { error: 'invalid_role_for_visibility', message: 'Commenter role is only meaningful under private visibility.' },
        400,
      );
    }

    const [existing] = await db
      .select({ userId: documentCollaborators.userId })
      .from(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    await db
      .update(documentCollaborators)
      .set({ role })
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));

    const [row] = await db
      .select({
        userId: documentCollaborators.userId,
        role: documentCollaborators.role,
        grantedBy: documentCollaborators.grantedBy,
        createdAt: documentCollaborators.createdAt,
        displayName: users.displayName,
      })
      .from(documentCollaborators)
      .innerJoin(users, eq(users.id, documentCollaborators.userId))
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));

    const body: Collaborator = {
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as CollaboratorRole,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt.toISOString(),
    };
    return c.json(body, 200);
  });

  app.delete('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    await db
      .delete(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    return new Response(null, { status: 204 });
  });
}
```

- [ ] **Step 5: Register the routes**

Modify `apps/api/src/app.ts`. Add the import near the other route imports:

```ts
import { registerCollaboratorRoutes } from './routes/collaborators.ts';
```

And add the registration call inside `createApp` near the other `register…` calls (e.g. after `registerDocumentRoutes(app, deps);`):

```ts
registerCollaboratorRoutes(app, deps);
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @primer/api test collaborators.test
```

Expected: all tests pass.

- [ ] **Step 7: Full suite**

```bash
pnpm --filter @primer/api test
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/collaborators.ts apps/api/src/routes/collaborators.test.ts \
        apps/api/src/app.ts packages/shared/src/api.ts
git commit -m "$(cat <<'EOF'
feat(collab): management endpoints + notifier wiring

GET/POST/PATCH/DELETE /api/documents/:docId/collaborators — owner-only,
403 on canRead but not canManage, 404 on unreadable. Enforces
owner_not_collaborator, invalid_role_for_visibility (no commenter under
org), and collaborator_exists (409 on unique-constraint violation).

POST fires notifier.notifyCollaboratorAdded fire-and-forget after commit;
self-suppression is handled inside the notifier implementations.

Refs #40
EOF
)"
```

---

### Task 4: Extend `PATCH /api/documents/:docId` with body-dispatched `visibility` field

**Files:**
- Modify: `apps/api/src/routes/documents.ts` (PATCH handler)
- Modify: `apps/api/src/routes/documents.test.ts` (new visibility scenarios)

**Interfaces:**
- Consumes: `canEdit`, `canManage`, `effectiveRole`, `loadCollaboratorRole` (already imported)
- Produces: PATCH now accepts `{ title?, description?, visibility? }`; body dispatches to `canManage` when `visibility` is present, else `canEdit`.

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/routes/documents.test.ts` (the `describe('doc access under visibility + collaborators')` block from Sub 1 already has the `withMultiUserApp` helper — reuse it):

```ts
describe('PATCH /api/documents/:docId visibility', () => {
  it('owner can flip visibility to private', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db
        .select({ visibility: documents.visibility })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.visibility).toBe('private');
    });
  });

  it('editor collab CANNOT flip visibility (canManage owner-only)', async () => {
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
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('mixed body (title + visibility) requires canManage', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      // Editor can PATCH title alone (canEdit)…
      const okRes = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ title: 'Edited by editor' }),
      });
      expect(okRes.status).toBe(200);
      // …but not title + visibility (mixed body is manage).
      const denyRes = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ title: 'Sneak', visibility: 'private' }),
      });
      expect(denyRes.status).toBe(403);
    });
  });

  it('invalid visibility value → 400', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ visibility: 'public' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @primer/api test documents.test
```

Expected: new visibility tests fail (PATCH doesn't accept `visibility` today).

- [ ] **Step 3: Extend the PATCH handler**

In `apps/api/src/routes/documents.ts`, modify the `PATCH /api/documents/:docId` handler. The current shape:

```ts
let payload: { title?: unknown; description?: unknown };
```

becomes:

```ts
let payload: { title?: unknown; description?: unknown; visibility?: unknown };
```

Extend the body validation. Add after the description parsing block, before the `existing` lookup:

```ts
const hasVisibility = Object.prototype.hasOwnProperty.call(payload, 'visibility');
let visibility: 'org' | 'private' | undefined;
if (hasVisibility) {
  if (payload.visibility !== 'org' && payload.visibility !== 'private') {
    return c.json(
      { error: 'invalid_body', message: "visibility must be 'org' or 'private'" },
      400,
    );
  }
  visibility = payload.visibility;
}

if (!hasTitle && !hasDescription && !hasVisibility) {
  return c.json({ error: 'invalid_body', message: 'Provide title, description, or visibility.' }, 400);
}
```

Then replace the existing empty-body check earlier in the handler (the current `if (!hasTitle && !hasDescription)` block) — remove it, since the new combined check above covers the empty case.

Update the gate. Currently:

```ts
if (existing.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);
```

Sub 1 already replaced this with the `canEdit` pattern. Extend it to dispatch:

```ts
// Sub 1 wired this to canEdit. Sub 2: if the body includes any manage-only
// field, require canManage instead.
const requiresManage = hasVisibility;
if (requiresManage) {
  if (!canManage(eff)) return c.json({ error: 'forbidden' }, 403);
} else {
  if (!canEdit(eff)) return c.json({ error: 'forbidden' }, 403);
}
```

Update the `updates` object to include `visibility` when present:

```ts
const updates: { title?: string; description?: string | null; visibility?: 'org' | 'private' } = {};
// … existing title / description assignments …
if (hasVisibility) {
  updates.visibility = visibility!;
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @primer/api test documents.test
```

Expected: all pass.

- [ ] **Step 5: Full suite**

```bash
pnpm --filter @primer/api test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts
git commit -m "$(cat <<'EOF'
feat(routes): accept visibility on PATCH /api/documents/:docId

Body dispatches on manage-only fields: a body containing `visibility`
(alone or mixed with title/description) requires canManage — owner-only.
Title/description-only bodies still require canEdit (owner + editor
collabs). Invalid visibility strings return invalid_body.

Refs #40
EOF
)"
```

---

### Task 5: User typeahead endpoint

**Files:**
- Modify: `apps/api/src/routes/users.ts` (add typeahead endpoint)
- Modify: `packages/shared/src/api.ts` (add DTO)
- Create: `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Consumes: existing `users` schema, `documentCollaborators` schema, `documents` schema
- Produces:
  - `UserSearchResponse { users: Array<{ id: string; displayName: string; email: string }> }`
  - `GET /api/users?q=<name-prefix>&docId=<uuid>?`

- [ ] **Step 1: Add the DTO**

Append to `packages/shared/src/api.ts`:

```ts
export interface UserSearchHit {
  id: string;
  displayName: string;
  email: string;
}

export interface UserSearchResponse {
  users: UserSearchHit[];
}
```

- [ ] **Step 2: Write failing tests**

Create `apps/api/src/routes/users.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documentCollaborators, users } from '@primer/shared/schema';
import type { UserSearchResponse } from '@primer/shared/api';
import { asUser } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-users-typeahead-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    // mock-user-1 is preserved by testing/setup.ts with canonical name "Mock User".
    // Skip it here; seed the others fresh (setup truncates non-mock users).
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Bob Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Charlie Three' },
        { id: 'mock-user-4', email: 'four@p.t', displayName: 'Bobby Four' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/users (typeahead)', () => {
  it('returns matches by display-name prefix (case-insensitive)', async () => {
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=Bob', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      const names = body.users.map((u) => u.displayName).sort();
      expect(names).toEqual(['Bob Two', 'Bobby Four']);
    });
  });

  it('returns empty result when q is empty', async () => {
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      expect(((await res.json()) as UserSearchResponse).users).toEqual([]);
    });
  });

  it('excludes owner and existing collaborators when docId is provided', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app); // owned by mock-user-1 (Alice Owner)
      // Add mock-user-2 (Bob Two) as an existing collaborator.
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      // Query for "Bob" or "Alice" — owner + existing collab should be filtered out.
      const res = await app.request(
        `/api/users?q=Bo&docId=${upload.documentId}`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      const names = body.users.map((u) => u.displayName);
      expect(names).toEqual(['Bobby Four']); // Bob Two excluded (existing), only Bobby remains.
    });
  });

  it('caps result at 20 rows', async () => {
    await withMultiUserApp(async (app) => {
      // Seed 25 users whose displayName starts with "Zed".
      const inserts = Array.from({ length: 25 }, (_, i) => ({
        id: `zed-user-${i}`,
        email: `zed-${i}@p.t`,
        displayName: `Zed User ${String(i).padStart(2, '0')}`,
      }));
      await db.insert(users).values(inserts).onConflictDoNothing();
      const res = await app.request('/api/users?q=Zed', { headers: asUser('mock-user-1') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      expect(body.users).toHaveLength(20);
    });
  });

  it('missing docId still returns matches (owner-only filter is optional)', async () => {
    // With no docId, only the caller is excluded — nothing else. Query "Mock"
    // matches the canonical mock-user-1 seed ("Mock User"), which is not the
    // caller here (mock-user-3), so it should surface.
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=Mock', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      expect(body.users.map((u) => u.displayName)).toEqual(['Mock User']);
    });
  });
});
```

- [ ] **Step 3: Run the failing tests**

```bash
pnpm --filter @primer/api test users.test
```

Expected: fails — no `/api/users` route today (only `/api/users/mentionable`).

- [ ] **Step 4: Implement the endpoint**

Modify `apps/api/src/routes/users.ts` to add the typeahead endpoint alongside the existing `/mentionable` one:

```ts
import type { Hono } from 'hono';
import { and, eq, ilike, ne, notInArray, sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { documents, documentCollaborators, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import type { MentionableUsersResponse, UserSearchResponse } from '@primer/shared';

const TYPEAHEAD_LIMIT = 20;

export function registerUserRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/users/mentionable', async (c) => {
    const me = c.get('user');
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(ne(users.id, me.id));
    const body: MentionableUsersResponse = { users: rows };
    return c.json(body, 200);
  });

  app.get('/api/users', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) {
      const empty: UserSearchResponse = { users: [] };
      return c.json(empty, 200);
    }

    const docId = c.req.query('docId') ?? null;

    // Excluded ids: caller + (optionally) owner + existing collaborators.
    const excluded = new Set<string>([c.get('user').id]);
    if (docId) {
      const [doc] = await db
        .select({ uploaderId: documents.uploaderId })
        .from(documents)
        .where(eq(documents.id, docId));
      if (doc) {
        excluded.add(doc.uploaderId);
        const collabRows = await db
          .select({ userId: documentCollaborators.userId })
          .from(documentCollaborators)
          .where(eq(documentCollaborators.documentId, docId));
        for (const r of collabRows) excluded.add(r.userId);
      }
    }

    const rows = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(
        and(
          ilike(users.displayName, `${q}%`),
          notInArray(users.id, Array.from(excluded)),
        ),
      )
      .orderBy(sql`lower(${users.displayName})`)
      .limit(TYPEAHEAD_LIMIT);

    const body: UserSearchResponse = { users: rows };
    return c.json(body, 200);
  });
}
```

Note: the caller is always excluded (they don't need to see themselves in a typeahead). The owner exclusion happens only when `docId` is provided (it may match the caller anyway, which is fine — set semantics deduplicate).

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @primer/api test users.test
```

Expected: all pass.

- [ ] **Step 6: Full suite**

```bash
pnpm --filter @primer/api test
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts packages/shared/src/api.ts
git commit -m "$(cat <<'EOF'
feat(users): typeahead search endpoint for the sharing modal

GET /api/users?q=<prefix>&docId=<uuid>? — up to 20 users matching a
case-insensitive display-name prefix. Always excludes the caller;
excludes the doc's owner + existing collaborators when docId is
provided. Empty q returns an empty list (no full-user-list dump).

Refs #40
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

- [ ] **Step 2: Typecheck (API)**

```bash
pnpm --filter @primer/api typecheck
```

Expected: no errors.

- [ ] **Step 3: Typecheck (shared package if it has one)**

```bash
pnpm --filter @primer/shared typecheck 2>/dev/null || echo "no shared typecheck script (skip)"
```

- [ ] **Step 4: Grep for stragglers**

Verify no owner-manage checks exist outside the new endpoints. Search for any remaining `uploaderId ===`/`uploaderId !==` in the routes/mcp directories — should still be zero after Sub 1's wire-through.

```bash
grep -RIn "uploaderId ===\|uploaderId !==\|uploader_id ===\|uploader_id !==" apps/api/src/routes apps/api/src/mcp
```

Expected: no matches.

- [ ] **Step 5: STOP**

Do not push. Do not open a PR. Report back to the controller with the verification results. The controller will pause for user greenlight before push + PR (per the no-auto-push policy).

## Self-Review

**Spec coverage** (Sub 2 section of `docs/superpowers/specs/2026-07-02-doc-collaborators-design.md`):

- `GET /api/documents/:docId/collaborators` (list, owner-only) → Task 3. ✓
- `POST /api/documents/:docId/collaborators` (add, owner-only, role/visibility validation) → Task 3. ✓
- `PATCH /api/documents/:docId/collaborators/:userId` (change role, owner-only) → Task 3. ✓
- `DELETE /api/documents/:docId/collaborators/:userId` (remove, owner-only) → Task 3. ✓
- Extend `PATCH /api/documents/:docId` to accept `visibility`; body-dispatched → Task 4. ✓
- `GET /api/users?q=<name-prefix>&docId=<uuid>` typeahead → Task 5. ✓
- Extend `Notifier` interface with `notifyCollaboratorAdded` → Task 2. ✓
- Update `NoopNotifier` (no-op) and `MailgunNotifier` (single-recipient email; self-add suppressed at notifier layer) → Task 2. ✓
- Call `notifyCollaboratorAdded` fire-and-forget from add endpoint after commit → Task 3. ✓
- SpyNotifier tests: add fires exactly once with the right args; role change and remove do not fire; self-add is suppressed at the notifier layer → Tasks 2 (mailgun) + 3 (endpoint). ✓
- Follow-ups from Sub 1's whole-branch review (unused import, redundant SELECT, explicit truncate list) → Task 1. ✓

Placeholder scan: none — every step has runnable commands or code.

Type consistency: `CollaboratorRole` and `Visibility` types referenced identically across all tasks (imported from `../lib/permissions.ts`); DTO field names (`userId`, `role`, `grantedBy`, `createdAt`, `displayName`) match between the DTO definitions in `packages/shared/src/api.ts` (Task 3) and the endpoint response shapes (Tasks 3, 5).
