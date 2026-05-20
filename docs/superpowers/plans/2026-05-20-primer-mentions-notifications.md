# Primer Sub-Project 6 (Mentions + Email Notifications) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up `@`-mentions and email notifications. Users type `@` in any comment composer, pick a teammate from a typeahead, and tagged or thread-participant users receive an email via Resend with a version-pinned deep link that scrolls and highlights the target thread on arrival.

**Architecture:** Frontend tracks selected mentions as a `Set<string>` of user IDs alongside the plain-text body, and submits both. Backend validates `mentions[]`, persists the comment, and fires a single fire-and-forget `notifier.notifyComment(...)` after the response goes out. The notifier collapses the previous two-method interface into one call that takes both `mentionedUserIds` and `participantUserIds`, does per-recipient dedup, and renders one email per recipient via Resend. SPA hash-scrolls to `#thread-:id` on arrival.

**Tech Stack:** TypeScript 6 + Hono 4 (Node 24) + Drizzle 0.45 + postgres.js + Vitest 4 + Resend (via `fetch`, no SDK) on the API; React 19 + Vite 8 + TanStack Query 5 + Tailwind 4 on the web side.

**Companion spec:** `docs/superpowers/specs/2026-05-20-primer-mentions-notifications-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Start from `master` (currently `0a009c7`, the SP6 spec commit). T1 creates `feat/mentions-notifications`.
- Postgres is up (`pnpm db:up` if not). `.env` exists at repo root.
- pnpm 11.1.0 at `~/.local/bin/pnpm`, Node 24 in the Nix store. **Every Bash command starts with:**
  ```bash
  export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
  ```
- SSH-key git signing works without prompting. Commit normally (no `--no-gpg-sign`).
- All work commits on `feat/mentions-notifications`. Final squash-merge to master is the last task.
- Resend account: domain `sequence-demos.xyz` already verified; sender `primer@sequence-demos.xyz`. `RESEND_API_KEY` will be set in Railway when SP6 ships; locally it's optional (notifier falls back to NoopNotifier).

---

## File map

```
packages/shared/src/
  api.ts                                  # MOD — mentions on requests; MentionableUser DTO

apps/api/src/
  notifications/
    notifier.ts                           # MOD — single notifyComment method + NotifyCommentArgs
    notifier.test.ts                      # MOD — NoopNotifier shape
    mentions.ts                           # NEW — validateAndCleanMentions helper
    mentions.test.ts                      # NEW
    resend.ts                             # NEW — ResendNotifier class
    resend.test.ts                        # NEW
  routes/
    users.ts                              # NEW — GET /api/users/mentionable
    users.test.ts                         # NEW
    threads.ts                            # MOD — accept mentions, validate, notifyComment
    threads.test.ts                       # MOD — mention validation tests
    comments.ts                           # MOD — accept mentions on reply + edit, diff on edit
    comments.test.ts                      # MOD
  app.ts                                  # MOD — register registerUserRoutes
  index.ts                                # MOD — env-driven notifier selection

apps/web/src/
  components/
    MentionTextarea.tsx                   # NEW — textarea + caret typeahead popover
    reconcileMentions.ts                  # NEW — pure helper extracted for testing
    reconcileMentions.test.ts             # NEW
    NewThreadComposer.tsx                 # MOD — use MentionTextarea
    ThreadCard.tsx                        # MOD — use MentionTextarea in reply + edit; render @ spans
    CommentSidebar.tsx                    # MOD — optional controlled collapsed prop
  queries/
    users.ts                              # NEW — useMentionableUsers
  routes/
    document.tsx                          # MOD — own collapsed state, hash effect, scroll + onHighlight
```

---

## Phase A — Branch + shared types

### Task 1: Feature branch + DTO additions

**Files:**
- Modify: `packages/shared/src/api.ts`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/taylan/development/polygon/primer
git status   # confirm clean on master at 0a009c7
git checkout -b feat/mentions-notifications
git log --oneline -3
```

- [ ] **Step 2: Add DTOs to `packages/shared/src/api.ts`**

Find `CreateThreadRequest` and `CommentBodyRequest`. Add an optional `mentions` field to both. Then append a new `MentionableUser` DTO and a list response.

Replace the existing block:

```ts
export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
}

export interface CommentBodyRequest {
  body: string;
}
```

With:

```ts
export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
  mentions?: string[];
}

export interface CommentBodyRequest {
  body: string;
  mentions?: string[];
}

export interface MentionableUser {
  id: string;
  displayName: string;
  email: string;
}

export interface MentionableUsersResponse {
  users: MentionableUser[];
}
```

- [ ] **Step 3: Typecheck all workspaces**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: all clean. The fields are optional so adding them is non-breaking.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/api.ts
git commit -m "feat(shared): mentions on request DTOs + MentionableUser"
git log --oneline -3
```

---

## Phase B — Schema index

### Task 2: Partial index on `comments.thread_id`

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Generated: `apps/api/drizzle/<timestamp>_*.sql`

- [ ] **Step 1: Add index to `comments` table definition**

Open `packages/shared/src/schema.ts`. Find the existing `comments = pgTable(...)` definition. The trailing options object likely has the column shape. Add a partial index in the table's options block.

Look for the existing comments table block. After the column definitions (and before the closing `})`), add an index reference. The Drizzle pattern for a partial index:

```ts
import { sql } from 'drizzle-orm';
// ...
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
    // ... existing columns unchanged
  },
  (t) => ({
    byThreadAlive: index('comments_thread_id_alive_idx')
      .on(t.threadId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);
```

If `sql` from `drizzle-orm` and `index` from `drizzle-orm/pg-core` aren't already imported at the top of the file, add them.

If `comments` already has a table-options callback with other indexes, just add the new key alongside.

- [ ] **Step 2: Generate the migration**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api run db:generate
```

Inspect the generated SQL file (newest under `apps/api/drizzle/`):

```bash
ls -lt apps/api/drizzle/ | head -3
cat $(ls -t apps/api/drizzle/0*.sql | head -1)
```

Expected: a single `CREATE INDEX ... ON "comments" ("thread_id") WHERE "deleted_at" IS NULL;` statement.

- [ ] **Step 3: Apply to dev + test DBs**

```bash
pnpm --filter @primer/api run db:migrate
pnpm --filter @primer/api run db:migrate:test
```

Both should report "Migrations applied."

- [ ] **Step 4: Verify**

```bash
docker compose exec -T postgres psql -U primer -d primer -c "\d comments" 2>&1 | grep -i thread
```

Expected: line showing the new partial index.

- [ ] **Step 5: Typecheck + tests**

```bash
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
```

Expected: 173 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schema.ts apps/api/drizzle
git commit -m "feat(shared): partial index on comments.thread_id WHERE deleted_at IS NULL"
git log --oneline -3
```

---

## Phase C — Notifier interface refactor

### Task 3: Collapse Notifier interface to `notifyComment`

**Files:**
- Modify: `apps/api/src/notifications/notifier.ts`
- Modify: `apps/api/src/routes/threads.ts` (existing call sites)
- Modify: `apps/api/src/routes/comments.ts` (existing call sites)

- [ ] **Step 1: Replace `apps/api/src/notifications/notifier.ts`**

```ts
import { logger } from '../logger.ts';

export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  actorUserId: string;
}

export interface Notifier {
  notifyComment(args: NotifyCommentArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
}
```

- [ ] **Step 2: Update the existing call sites in threads.ts and comments.ts to stub the new shape**

In `apps/api/src/routes/threads.ts`, find the existing `deps.notifier.notifyMentions(...)` and `deps.notifier.notifyReplyParticipants(...)` calls. Replace each with a single placeholder that won't crash:

```ts
// In threads.ts after a thread + first comment is persisted, where notifyMentions
// was being called with mentions: []:

void deps.notifier
  .notifyComment({
    doc: { id: docId, title: docTitle },                  // use the vars already in scope
    version: { id: versionId, versionNumber },            // already in scope from the doc/version lookup
    thread: { id: insertedThread.id },
    comment: { id: insertedComment.id, body: insertedComment.body, createdAt: insertedComment.createdAt },
    mentionedUserIds: [],          // populated in Task 6
    participantUserIds: [],        // populated in Task 6
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId: insertedComment.id }, 'notifier failed'));
```

Do the same in `apps/api/src/routes/comments.ts` for both the reply path and the (currently-empty) edit path. **If a variable like `docTitle` or `versionNumber` isn't in scope yet, fetch it via a small SQL extension to the existing thread→version→doc lookup.** Pattern:

```ts
const [ctx] = (await db.execute(sql`
  SELECT d.id AS doc_id, d.title AS doc_title,
         v.id AS version_id, v.version_number AS version_number
  FROM threads t
  INNER JOIN versions v ON v.id = t.version_id
  INNER JOIN documents d ON d.id = v.document_id
  WHERE t.id = ${threadId}
  LIMIT 1
`)) as unknown as Array<{
  doc_id: string;
  doc_title: string;
  version_id: string;
  version_number: number;
}>;
```

Reuse the result for both the existing validation and the notifier args.

(For the new-thread POST in threads.ts, the version + doc info is already loaded earlier in the handler.)

- [ ] **Step 3: Update the test for NoopNotifier**

Open `apps/api/src/notifications/notifier.test.ts` (if it exists) and replace its body with:

```ts
import { describe, it, expect } from 'vitest';
import { NoopNotifier, type NotifyCommentArgs } from './notifier.ts';

const ARGS: NotifyCommentArgs = {
  doc: { id: 'doc-1', title: 'Test Doc' },
  version: { id: 'v-1', versionNumber: 1 },
  thread: { id: 't-1' },
  comment: { id: 'c-1', body: 'hi', createdAt: new Date() },
  mentionedUserIds: [],
  participantUserIds: [],
  actorUserId: 'mock-user-1',
};

describe('NoopNotifier', () => {
  it('resolves without error', async () => {
    const n = new NoopNotifier();
    await expect(n.notifyComment(ARGS)).resolves.toBeUndefined();
  });
});
```

If the file doesn't exist, create it with this content.

- [ ] **Step 4: Run tests + typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -10
```

Expected: typecheck clean, 173+ tests still pass. (Any test that asserted on `notifyMentions` / `notifyReplyParticipants` should already be removed or updated; if vitest reports a missing-method failure, find that test and switch its assertion to `notifyComment`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications apps/api/src/routes
git commit -m "feat(api): collapse Notifier interface to single notifyComment"
git log --oneline -3
```

---

## Phase D — Mention validation helper

### Task 4: `validateAndCleanMentions` (TDD)

**Files:**
- Create: `apps/api/src/notifications/mentions.ts`
- Create: `apps/api/src/notifications/mentions.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/notifications/mentions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { validateAndCleanMentions, MAX_MENTIONS } from './mentions.ts';

const KNOWN_USERS = new Set(['mock-user-1', 'mock-user-2', 'mock-user-3']);
const ACTOR = 'mock-user-1';

describe('validateAndCleanMentions', () => {
  it('returns ok=true with the deduplicated, self-removed array for a valid input', () => {
    const r = validateAndCleanMentions(
      ['mock-user-2', 'mock-user-3', 'mock-user-2', 'mock-user-1'],
      ACTOR,
      KNOWN_USERS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mentions.sort()).toEqual(['mock-user-2', 'mock-user-3']);
    }
  });

  it('returns ok=true with [] for an undefined input', () => {
    const r = validateAndCleanMentions(undefined, ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });

  it('returns ok=true with [] for an empty array', () => {
    const r = validateAndCleanMentions([], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });

  it('returns 400 invalid_mention when any id is unknown', () => {
    const r = validateAndCleanMentions(['mock-user-2', 'ghost'], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_mention');
  });

  it('returns 400 too_many_mentions when the input exceeds the cap', () => {
    const big = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `mock-user-${i + 100}`);
    const r = validateAndCleanMentions(big, ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('too_many_mentions');
  });

  it('returns 400 invalid_mention when input is not an array', () => {
    const r = validateAndCleanMentions('not-an-array' as unknown as string[], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_mention');
  });

  it('removes the actor silently (no error) even if mentioned', () => {
    const r = validateAndCleanMentions(['mock-user-1'], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test notifications/mentions
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/notifications/mentions.ts`

```ts
export const MAX_MENTIONS = 25;

export type ValidationResult =
  | { ok: true; mentions: string[] }
  | { ok: false; error: 'invalid_mention' | 'too_many_mentions'; message: string };

/**
 * Cleans and validates a `mentions` array submitted with a comment write:
 *   - Tolerates undefined → returns [].
 *   - Rejects non-array input as 'invalid_mention'.
 *   - Rejects input over MAX_MENTIONS items (counted BEFORE dedup/self-removal
 *     so a request that submits 26 distinct ids is rejected even if 25 of them
 *     happen to be unique after cleaning).
 *   - Rejects unknown user IDs as 'invalid_mention'.
 *   - Silently removes the actor's own id and de-duplicates.
 */
export function validateAndCleanMentions(
  input: string[] | undefined,
  actorUserId: string,
  knownUserIds: ReadonlySet<string>,
): ValidationResult {
  if (input === undefined) return { ok: true, mentions: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: 'invalid_mention', message: 'mentions must be an array' };
  }
  if (input.length > MAX_MENTIONS) {
    return {
      ok: false,
      error: 'too_many_mentions',
      message: `mentions must be ≤ ${MAX_MENTIONS}`,
    };
  }
  const seen = new Set<string>();
  for (const id of input) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'invalid_mention', message: 'mention ids must be non-empty strings' };
    }
    if (!knownUserIds.has(id)) {
      return { ok: false, error: 'invalid_mention', message: `unknown user id: ${id}` };
    }
    if (id !== actorUserId) seen.add(id);
  }
  return { ok: true, mentions: [...seen] };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test notifications/mentions
pnpm --filter @primer/api typecheck
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/mentions.ts apps/api/src/notifications/mentions.test.ts
git commit -m "feat(api): validateAndCleanMentions helper"
git log --oneline -3
```

---

## Phase E — `/api/users/mentionable`

### Task 5: New route (TDD)

**Files:**
- Create: `apps/api/src/routes/users.ts`
- Create: `apps/api/src/routes/users.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/routes/users.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { MentionableUsersResponse } from '@primer/shared';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>,
  useMulti = false,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-users-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: useMulti ? mockMultiResolver : mockResolver,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/users/mentionable', () => {
  it('returns all users except the caller', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable');
      expect(res.status).toBe(200);
      const body = (await res.json()) as MentionableUsersResponse;
      const ids = body.users.map((u) => u.id).sort();
      expect(ids).toContain('mock-user-2');
      expect(ids).not.toContain('mock-user-1'); // caller is mock-user-1 (mockResolver)
    });
  });

  it('returns each user with id, displayName, email', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable');
      const body = (await res.json()) as MentionableUsersResponse;
      const u = body.users.find((x) => x.id === 'mock-user-2');
      expect(u).toEqual({ id: 'mock-user-2', displayName: 'User Two', email: 'two@p.t' });
    });
  });

  it('reflects X-Mock-User-Id (caller filter follows the header)', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable', {
        headers: { 'x-mock-user-id': 'mock-user-2' },
      });
      const body = (await res.json()) as MentionableUsersResponse;
      const ids = body.users.map((u) => u.id);
      expect(ids).not.toContain('mock-user-2');
      expect(ids).toContain('mock-user-1');
    }, true);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test routes/users
```

Expected: 404 because route isn't registered.

- [ ] **Step 3: Implement**

File: `apps/api/src/routes/users.ts`

```ts
import type { Hono } from 'hono';
import { ne } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import type { MentionableUsersResponse } from '@primer/shared';

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
}
```

In `apps/api/src/app.ts`, register the route alongside other `register*` calls. Add the import:

```ts
import { registerUserRoutes } from './routes/users.ts';
```

And inside `createApp`, after the existing route registrations:

```ts
registerUserRoutes(app);
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test routes/users
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

Expected: 3 new tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts apps/api/src/app.ts
git commit -m "feat(api): GET /api/users/mentionable for @ typeahead"
git log --oneline -3
```

---

## Phase F — Wire mentions through routes

### Task 6: POST `/api/versions/:vid/threads` validates + persists + notifies (TDD)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
describe('POST /api/versions/:vid/threads — mentions', () => {
  it('persists cleaned mentions[] on the first comment', async () => {
    await withApp(async (app) => {
      // Seed a second user that can be mentioned.
      await db
        .insert(users)
        .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
        .onConflictDoNothing();
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: '@Two please look',
          mentions: ['mock-user-2'],
        }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { commentId: string };
      const [row] = await db.select().from(comments).where(eq(comments.id, out.commentId));
      expect(row.mentions).toEqual(['mock-user-2']);
    });
  });

  it('returns 400 invalid_mention when an unknown user id is in mentions', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hi',
          mentions: ['ghost-user'],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_mention');
    });
  });

  it('silently drops the actor from mentions', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'self',
          mentions: ['mock-user-1'],
        }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { commentId: string };
      const [row] = await db.select().from(comments).where(eq(comments.id, out.commentId));
      expect(row.mentions).toEqual([]);
    });
  });

  it('fires notifyComment with mentionedUserIds populated', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
        .onConflictDoNothing();
      const { versionId } = await seedDocument();

      const captured: Parameters<typeof spy>[0][] = [];
      function spy(args: unknown) {
        captured.push(args as never);
      }
      const spyNotifier = {
        async notifyComment(args: unknown) {
          spy(args);
        },
      };
      // Rebuild the app with a spy notifier for this test.
      const spyApp = createApp({
        storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-spy-'))),
        notifier: spyNotifier as never,
      });
      // Need to re-seed because we just made a new app pointing at the same DB.
      await db.insert(users).values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
      ]).onConflictDoNothing();
      // Re-seed a doc for the new app.
      const seed2 = await seedDocument();
      await spyApp.request(`/api/versions/${seed2.versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: '@Two hi',
          mentions: ['mock-user-2'],
        }),
      });
      // Notifier is fire-and-forget; give it a microtask tick.
      await new Promise((r) => setTimeout(r, 50));
      expect(captured).toHaveLength(1);
      const a = captured[0] as { mentionedUserIds: string[]; actorUserId: string };
      expect(a.mentionedUserIds).toEqual(['mock-user-2']);
      expect(a.actorUserId).toBe('mock-user-1');
    });
  });
});
```

Add the `users` import to the test file's imports if not present:

```ts
import { users } from '@primer/shared/schema';
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test threads
```

Expected: the 4 new tests fail (mentions are not yet read from the body, the spy notifier sees no call).

- [ ] **Step 3: Implement in `apps/api/src/routes/threads.ts`**

In the `POST /api/versions/:versionId/threads` handler:

1. Read `mentions` from the JSON body:

```ts
const rawMentions: unknown = (payload as { mentions?: unknown }).mentions;
```

2. Build the known-user set from the database. Add this lookup right after the existing version/doc lookup (you only need the user IDs):

```ts
const userRows = await db.select({ id: users.id }).from(users);
const knownUserIds = new Set(userRows.map((r) => r.id));
```

3. Validate:

```ts
import { validateAndCleanMentions } from '../notifications/mentions.ts';
// ...
const validated = validateAndCleanMentions(
  rawMentions as string[] | undefined,
  user.id,
  knownUserIds,
);
if (!validated.ok) {
  return c.json({ error: validated.error, message: validated.message }, 400);
}
const cleanedMentions = validated.mentions;
```

4. Persist mentions onto the comment row. Find the existing `db.insert(comments).values({...})` in the transaction and replace `mentions: []` (or wherever the column is set) with `mentions: cleanedMentions`:

```ts
await tx.insert(comments).values({
  id: commentId,
  threadId,
  authorId: user.id,
  body,
  mentions: cleanedMentions,   // CHANGED
});
```

5. Fire `notifyComment` with the cleaned mentions (replacing whatever placeholder was put in Task 3):

```ts
void deps.notifier
  .notifyComment({
    doc: { id: docInfo.id, title: docInfo.title },
    version: { id: versionId, versionNumber: versionInfo.versionNumber },
    thread: { id: threadId },
    comment: { id: commentId, body, createdAt: insertedComment.createdAt },
    mentionedUserIds: cleanedMentions,
    participantUserIds: [],   // first comment in a thread: no prior participants
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId }, 'notifier failed'));
```

(Adjust variable names to match whatever's already in scope for doc title, version number, and `insertedComment.createdAt`.)

Add `users` to the existing `@primer/shared/schema` import at the top:

```ts
import { documents, versions, threads, comments, users } from '@primer/shared/schema';
```

And `logger` if it's not already imported:

```ts
import { logger } from '../logger.ts';
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test threads
pnpm --filter @primer/api typecheck
```

Expected: all threads tests pass including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes
git commit -m "feat(api): POST threads validates mentions + fires notifyComment"
git log --oneline -3
```

---

### Task 7: POST `/api/threads/:tid/replies` mentions (TDD)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`
- Modify: `apps/api/src/routes/comments.test.ts` (or `threads.test.ts` — wherever reply tests live)

- [ ] **Step 1: Failing tests**

Locate the existing reply test block (`describe('POST /api/threads/:tid/replies', ...)`). Append:

```ts
it('persists mentions[] on a reply and fires notifyComment with mention+participant sets', async () => {
  await withApp(async (app) => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
      ])
      .onConflictDoNothing();
    // Seed a thread with a first comment authored by mock-user-2.
    const { versionId, threadId } = await seedThreadWithComment({ authorId: 'mock-user-2' });

    const captured: { mentionedUserIds: string[]; participantUserIds: string[]; actorUserId: string }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-reply-spy-'))),
      notifier: {
        async notifyComment(args) {
          captured.push(args as never);
        },
      } as never,
    });

    const res = await spyApp.request(`/api/threads/${threadId}/replies`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Three look here', mentions: ['mock-user-3'] }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { commentId: string };
    const [row] = await db.select().from(comments).where(eq(comments.id, out.commentId));
    expect(row.mentions).toEqual(['mock-user-3']);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].mentionedUserIds).toEqual(['mock-user-3']);
    // mock-user-2 is the prior participant (first comment author); mock-user-1 is the actor.
    expect(captured[0].participantUserIds).toEqual(['mock-user-2']);
    expect(captured[0].actorUserId).toBe('mock-user-1');
  });
});

it('returns 400 invalid_mention when an unknown user id is in mentions', async () => {
  await withApp(async (app) => {
    const { threadId } = await seedThreadWithComment({ authorId: 'mock-user-1' });
    const res = await app.request(`/api/threads/${threadId}/replies`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hi', mentions: ['ghost'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_mention');
  });
});
```

If `seedThreadWithComment({ authorId })` doesn't exist yet, find the helper that seeds a thread + its first comment and extend it to accept an `authorId` override; default it to `'mock-user-1'` so existing tests keep working.

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test comments
```

Expected: 2 new tests fail.

- [ ] **Step 3: Implement in the reply handler**

In `apps/api/src/routes/comments.ts`, find the `POST /api/threads/:threadId/replies` handler. Apply the same pattern as Task 6, but also compute the prior-participants set:

```ts
import { validateAndCleanMentions } from '../notifications/mentions.ts';
import { sql } from 'drizzle-orm';
// ...

// (existing validation continues — extend with mentions)
const rawMentions: unknown = (payload as { mentions?: unknown }).mentions;

const userRows = await db.select({ id: users.id }).from(users);
const knownUserIds = new Set(userRows.map((r) => r.id));

const validated = validateAndCleanMentions(
  rawMentions as string[] | undefined,
  user.id,
  knownUserIds,
);
if (!validated.ok) {
  return c.json({ error: validated.error, message: validated.message }, 400);
}
const cleanedMentions = validated.mentions;

// Prior thread participants (the alive-comments index added in T2 covers this query):
const priorRows = (await db.execute(sql`
  SELECT DISTINCT author_id AS author_id
  FROM comments
  WHERE thread_id = ${threadId}
    AND deleted_at IS NULL
`)) as unknown as Array<{ author_id: string }>;

const mentionSet = new Set(cleanedMentions);
const participantUserIds = priorRows
  .map((r) => r.author_id)
  .filter((id) => id !== user.id && !mentionSet.has(id));

// (existing insert continues — extend with mentions)
await db.insert(comments).values({
  id: commentId,
  threadId,
  authorId: user.id,
  body,
  mentions: cleanedMentions,
});

// Also need the doc + version context for the notifier. Reuse the existing
// thread-soft-delete-guard query result (or extend it to also pull doc.title and
// version.id/version_number). Pattern:
const [ctx] = (await db.execute(sql`
  SELECT d.id AS doc_id, d.title AS doc_title,
         v.id AS version_id, v.version_number AS version_number
  FROM threads t
  INNER JOIN versions v ON v.id = t.version_id
  INNER JOIN documents d ON d.id = v.document_id
  WHERE t.id = ${threadId}
  LIMIT 1
`)) as unknown as Array<{
  doc_id: string;
  doc_title: string;
  version_id: string;
  version_number: number;
}>;

void deps.notifier
  .notifyComment({
    doc: { id: ctx.doc_id, title: ctx.doc_title },
    version: { id: ctx.version_id, versionNumber: ctx.version_number },
    thread: { id: threadId },
    comment: { id: commentId, body, createdAt: insertedRow.createdAt },
    mentionedUserIds: cleanedMentions,
    participantUserIds,
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId }, 'notifier failed'));
```

(`insertedRow` is whatever the existing handler stores from the insert. If it doesn't currently capture `createdAt`, run a `RETURNING created_at` or read back with a small select.)

Add the necessary imports if missing: `users` from `@primer/shared/schema`, `sql` from `drizzle-orm`, `logger`, `validateAndCleanMentions`.

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test comments
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/comments.ts apps/api/src/routes/comments.test.ts
git commit -m "feat(api): POST replies validates mentions + fires notifyComment with prior participants"
git log --oneline -3
```

---

### Task 8: PATCH `/api/comments/:id` mentions diff (TDD)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`
- Modify: `apps/api/src/routes/comments.test.ts`

- [ ] **Step 1: Failing tests**

Locate the existing PATCH-comment test block and append:

```ts
it('persists the new mentions[] and fires notifyComment for newly-added mentions only', async () => {
  await withApp(async (app) => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
      ])
      .onConflictDoNothing();
    const { threadId, commentId } = await seedThreadWithComment({
      authorId: 'mock-user-1',
      mentions: ['mock-user-2'],
    });

    const captured: { mentionedUserIds: string[]; participantUserIds: string[] }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-spy-'))),
      notifier: {
        async notifyComment(args) {
          captured.push(args as never);
        },
      } as never,
    });

    // Edit: keep mock-user-2, add mock-user-3.
    const res = await spyApp.request(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Two @Three', mentions: ['mock-user-2', 'mock-user-3'] }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(comments).where(eq(comments.id, commentId));
    expect(row.mentions.sort()).toEqual(['mock-user-2', 'mock-user-3']);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].mentionedUserIds).toEqual(['mock-user-3']); // diff only
    expect(captured[0].participantUserIds).toEqual([]);            // edits never re-notify participants
  });
});

it('does not fire notifyComment on edits that only remove mentions', async () => {
  await withApp(async (app) => {
    await db
      .insert(users)
      .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
      .onConflictDoNothing();
    const { commentId } = await seedThreadWithComment({
      authorId: 'mock-user-1',
      mentions: ['mock-user-2'],
    });

    const captured: unknown[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-rm-'))),
      notifier: {
        async notifyComment(args) {
          captured.push(args);
        },
      } as never,
    });

    const res = await spyApp.request(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'no longer tagging anyone', mentions: [] }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(0);
  });
});
```

Extend the `seedThreadWithComment` helper to accept `mentions?: string[]` (default `[]`).

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test comments
```

Expected: 2 new tests fail.

- [ ] **Step 3: Implement in the PATCH handler**

In `apps/api/src/routes/comments.ts`, find the `PATCH /api/comments/:commentId` handler. Extend it:

```ts
const rawMentions: unknown = (payload as { mentions?: unknown }).mentions;

const userRows = await db.select({ id: users.id }).from(users);
const knownUserIds = new Set(userRows.map((r) => r.id));

const validated = validateAndCleanMentions(
  rawMentions as string[] | undefined,
  user.id,
  knownUserIds,
);
if (!validated.ok) {
  return c.json({ error: validated.error, message: validated.message }, 400);
}
const cleanedMentions = validated.mentions;

// Diff against the persisted set BEFORE updating.
const [existing] = await db
  .select({ mentions: comments.mentions, threadId: comments.threadId })
  .from(comments)
  .where(eq(comments.id, commentId));
if (!existing) return c.json({ error: 'not_found' }, 404);
const previous = new Set(existing.mentions);
const newlyAdded = cleanedMentions.filter((id) => !previous.has(id));

// (existing UPDATE continues — extend with mentions)
await db
  .update(comments)
  .set({ body: trimmedBody, mentions: cleanedMentions, updatedAt: new Date() })
  .where(eq(comments.id, commentId));

if (newlyAdded.length > 0) {
  // Fetch the version + doc context for the notifier.
  const [ctx] = (await db.execute(sql`
    SELECT d.id AS doc_id, d.title AS doc_title,
           v.id AS version_id, v.version_number AS version_number,
           c.created_at AS created_at
    FROM comments c
    INNER JOIN threads t ON t.id = c.thread_id
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE c.id = ${commentId}
    LIMIT 1
  `)) as unknown as Array<{
    doc_id: string;
    doc_title: string;
    version_id: string;
    version_number: number;
    created_at: Date | string;
  }>;

  void deps.notifier
    .notifyComment({
      doc: { id: ctx.doc_id, title: ctx.doc_title },
      version: { id: ctx.version_id, versionNumber: ctx.version_number },
      thread: { id: existing.threadId },
      comment: {
        id: commentId,
        body: trimmedBody,
        createdAt: ctx.created_at instanceof Date ? ctx.created_at : new Date(ctx.created_at),
      },
      mentionedUserIds: newlyAdded,
      participantUserIds: [],   // edits never re-notify participants
      actorUserId: user.id,
    })
    .catch((err) => logger.error({ err, commentId }, 'notifier failed (edit)'));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test comments
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/comments.ts apps/api/src/routes/comments.test.ts
git commit -m "feat(api): PATCH comment fires notifyComment for newly-added mentions only"
git log --oneline -3
```

---

## Phase G — Resend notifier

### Task 9: `ResendNotifier` (TDD)

**Files:**
- Create: `apps/api/src/notifications/resend.ts`
- Create: `apps/api/src/notifications/resend.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/notifications/resend.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResendNotifier } from './resend.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { NotifyCommentArgs } from './notifier.ts';

const NOW = new Date('2026-05-20T12:00:00Z');

function args(over: Partial<NotifyCommentArgs> = {}): NotifyCommentArgs {
  return {
    doc: { id: 'doc-1', title: 'Test Doc' },
    version: { id: 'v-1', versionNumber: 3 },
    thread: { id: 'thread-abc' },
    comment: { id: 'c-1', body: 'hello @Alice', createdAt: NOW },
    mentionedUserIds: ['mock-user-2'],
    participantUserIds: [],
    actorUserId: 'mock-user-1',
    ...over,
  };
}

describe('ResendNotifier.notifyComment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Alice Tester' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
      ])
      .onConflictDoNothing();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'resend-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to api.resend.com with bearer auth and the expected body', async () => {
    const n = new ResendNotifier({
      apiKey: 'sk-test',
      fromAddress: 'primer@sequence-demos.xyz',
      appBaseUrl: 'https://primer.example',
    });
    await n.notifyComment(args());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe('primer@sequence-demos.xyz');
    expect(body.to).toBe('two@p.t');
    expect(body.subject).toBe("User One commented on 'Test Doc'");
    expect(body.html).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
    expect(body.text).toContain('https://primer.example/d/doc-1/v/3#thread-thread-abc');
  });

  it('renders mention-only signal copy', async () => {
    const n = new ResendNotifier({
      apiKey: 'k',
      fromAddress: 'p@s.x',
      appBaseUrl: 'https://p.x',
    });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: [] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('mentioned you in a comment');
    expect(body.text).not.toContain('replied to a thread');
  });

  it('renders reply-only signal copy', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: [], participantUserIds: ['mock-user-2'] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("replied to a thread you're in");
    expect(body.text).not.toContain('mentioned you');
  });

  it('renders combined signal copy', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({ mentionedUserIds: ['mock-user-2'], participantUserIds: ['mock-user-2'] }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("mentioned you and replied to a thread you're in");
  });

  it('sends one email per unique recipient (union, dedup)', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({
      mentionedUserIds: ['mock-user-2', 'mock-user-3'],
      participantUserIds: ['mock-user-2'],          // user-2 in both → still one email
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toValues = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).to);
    expect(toValues.sort()).toEqual(['three@p.t', 'two@p.t']);
  });

  it('excludes the actor even if accidentally in either list', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await n.notifyComment(args({
      mentionedUserIds: ['mock-user-1', 'mock-user-2'],   // actor accidentally included
      participantUserIds: ['mock-user-1'],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.to).toBe('two@p.t');
  });

  it('does not throw when Resend returns 5xx; logs and continues to the next recipient', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    await expect(
      n.notifyComment(args({ mentionedUserIds: ['mock-user-2', 'mock-user-3'] })),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('truncates doc title in subject at 50 chars', async () => {
    const n = new ResendNotifier({ apiKey: 'k', fromAddress: 'p@s.x', appBaseUrl: 'https://p.x' });
    const longTitle = 'A'.repeat(80);
    await n.notifyComment(args({ doc: { id: 'd', title: longTitle } }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.subject.length).toBeLessThanOrEqual('User One commented on '.length + 50 + 3);
    expect(body.subject).toContain('…');
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test notifications/resend
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/notifications/resend.ts`

```ts
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import { logger } from '../logger.ts';
import type { Notifier, NotifyCommentArgs } from './notifier.ts';

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  appBaseUrl: string; // e.g. https://primer-polygon.up.railway.app
}

interface UserRow {
  id: string;
  displayName: string;
  email: string;
}

const SUBJECT_TITLE_LIMIT = 50;
const BODY_EXCERPT_LIMIT = 280;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signalLead(actorName: string, mention: boolean, reply: boolean): string {
  if (mention && reply) return `${actorName} mentioned you and replied to a thread you're in.`;
  if (mention) return `${actorName} mentioned you in a comment.`;
  return `${actorName} replied to a thread you're in.`;
}

function renderSubject(actorName: string, docTitle: string): string {
  return `${actorName} commented on '${truncate(docTitle, SUBJECT_TITLE_LIMIT)}'`;
}

function renderText(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
): string {
  return [
    signalLead(actorName, mention, reply),
    '',
    `Doc: ${docTitle}`,
    '',
    commentExcerpt,
    '',
    `Open thread: ${url}`,
    '',
    'You received this because you were mentioned or are a participant in this Primer thread.',
  ].join('\n');
}

function renderHtml(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
): string {
  const lead = escapeHtml(signalLead(actorName, mention, reply));
  const safeTitle = escapeHtml(docTitle);
  const safeExcerpt = escapeHtml(commentExcerpt).replace(/\n/g, '<br/>');
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">${lead}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#737373;">Doc: <strong style="color:#171717;">${safeTitle}</strong></p>
    <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #fbbf24;background:#fef9c3;font-size:14px;line-height:1.5;color:#262626;">${safeExcerpt}</blockquote>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open thread</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were mentioned or are a participant in this Primer thread.</p>
  </td></tr>
</table>
</body></html>`;
}

export class ResendNotifier implements Notifier {
  constructor(private readonly cfg: ResendConfig) {}

  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    const mentionSet = new Set(args.mentionedUserIds);
    const participantSet = new Set(args.participantUserIds);
    const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
    recipientIds.delete(args.actorUserId);
    if (recipientIds.size === 0) return;

    const rows = (await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, [...recipientIds, args.actorUserId]))) as UserRow[];
    const actor = rows.find((u) => u.id === args.actorUserId);
    const actorName = actor?.displayName ?? 'Someone';

    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.doc.id}/v/${args.version.versionNumber}#thread-${args.thread.id}`;
    const excerpt = truncate(args.comment.body, BODY_EXCERPT_LIMIT);
    const subject = renderSubject(actorName, args.doc.title);

    for (const recipientId of recipientIds) {
      const recipient = rows.find((u) => u.id === recipientId);
      if (!recipient) {
        logger.warn({ recipientId }, 'recipient not found in users table, skipping');
        continue;
      }
      const mention = mentionSet.has(recipientId);
      const reply = participantSet.has(recipientId);
      const html = renderHtml(actorName, args.doc.title, excerpt, url, mention, reply);
      const text = renderText(actorName, args.doc.title, excerpt, url, mention, reply);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.cfg.fromAddress,
            to: recipient.email,
            subject,
            html,
            text,
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          logger.error(
            { status: res.status, recipientId, errBody: errBody.slice(0, 300) },
            'resend send failed',
          );
        }
      } catch (err) {
        logger.error({ err, recipientId }, 'resend fetch threw');
      }
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test notifications/resend
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

Expected: 8 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/resend.ts apps/api/src/notifications/resend.test.ts
git commit -m "feat(api): ResendNotifier — single notifyComment, per-recipient signal copy"
git log --oneline -3
```

---

### Task 10: Env-driven notifier selection in `index.ts`

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Update `apps/api/src/index.ts`**

Replace the existing `const notifier = new NoopNotifier();` line and import the new module:

```ts
import { NoopNotifier } from './notifications/notifier.ts';
import { ResendNotifier } from './notifications/resend.ts';
import type { Notifier } from './notifications/notifier.ts';
```

(Keep the existing imports; add the new `ResendNotifier` + type import.)

Then where the notifier was constructed:

```ts
function buildNotifier(): Notifier {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM;
  const appBaseUrl = process.env.AUTH_BASE_URL;
  if (apiKey && fromAddress && appBaseUrl) {
    logger.info({ fromAddress }, 'notifier: Resend enabled');
    return new ResendNotifier({ apiKey, fromAddress, appBaseUrl });
  }
  logger.warn(
    { hasApiKey: !!apiKey, hasFromAddress: !!fromAddress, hasAppBaseUrl: !!appBaseUrl },
    'notifier: Resend env incomplete, falling back to NoopNotifier',
  );
  return new NoopNotifier();
}
const notifier = buildNotifier();
```

`appBaseUrl` re-uses `AUTH_BASE_URL` so we don't introduce a new env. If Okta is wired, the URL is already correct for deep links.

- [ ] **Step 2: Update `.env.example`**

After the existing auth block, append:

```bash

# Email notifications (optional)
# Resend API key + verified sender. Falls back to NoopNotifier when unset.
# RESEND_API_KEY=
# EMAIL_FROM=primer@sequence-demos.xyz
```

- [ ] **Step 3: Smoke check (mock mode, no Resend key)**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1
AUTH_MODE=mock pnpm dev > /tmp/primer-sp6-smoke.log 2>&1 &
PID=$!
sleep 6
grep -i 'notifier' /tmp/primer-sp6-smoke.log | tail -3
kill $PID 2>/dev/null
wait 2>/dev/null
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
```

Expected: log line "notifier: Resend env incomplete, falling back to NoopNotifier" or similar warning.

- [ ] **Step 4: Run full api suite**

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts .env.example
git commit -m "feat(api): env-driven notifier selection (Resend vs Noop)"
git log --oneline -3
```

---

## Phase H — Frontend: typeahead + rendering

### Task 11: `useMentionableUsers()` query

**Files:**
- Create: `apps/web/src/queries/users.ts`

- [ ] **Step 1: Create**

File: `apps/web/src/queries/users.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import type { MentionableUsersResponse, MentionableUser } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useMentionableUsers() {
  return useQuery({
    queryKey: ['mentionable-users'],
    queryFn: async (): Promise<MentionableUser[]> => {
      const res = await api('/api/users/mentionable');
      if (!res.ok) throw new Error(`mentionable users fetch failed: ${res.status}`);
      const body = (await res.json()) as MentionableUsersResponse;
      return body.users;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/queries/users.ts
git commit -m "feat(web): useMentionableUsers query"
git log --oneline -3
```

---

### Task 12: `reconcileMentions` pure helper (TDD)

**Files:**
- Create: `apps/web/src/components/reconcileMentions.ts`
- Create: `apps/web/src/components/reconcileMentions.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/web/src/components/reconcileMentions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { reconcileMentions } from './reconcileMentions.ts';

const USERS = [
  { id: 'u1', displayName: 'Alice Tester', email: 'a@p.t' },
  { id: 'u2', displayName: 'Bob Builder', email: 'b@p.t' },
  { id: 'u3', displayName: 'Carol O\'Brien', email: 'c@p.t' },
];

describe('reconcileMentions', () => {
  it('keeps an id whose display name appears in the body', () => {
    expect(reconcileMentions('hey @Alice Tester look', new Set(['u1', 'u2']), USERS)).toEqual(['u1']);
  });

  it('drops an id whose display name no longer appears in the body', () => {
    expect(reconcileMentions('hey look', new Set(['u1', 'u2']), USERS)).toEqual([]);
  });

  it('returns [] when set is empty', () => {
    expect(reconcileMentions('@Alice Tester', new Set(), USERS)).toEqual([]);
  });

  it('handles names with regex special characters', () => {
    expect(reconcileMentions('@Carol O\'Brien hi', new Set(['u3']), USERS)).toEqual(['u3']);
  });

  it('does not duplicate ids when name appears multiple times', () => {
    expect(reconcileMentions('@Alice Tester and @Alice Tester', new Set(['u1']), USERS)).toEqual(['u1']);
  });

  it('ignores ids whose user is missing from the users list', () => {
    expect(reconcileMentions('@Alice Tester', new Set(['u1', 'u-ghost']), USERS)).toEqual(['u1']);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/web test reconcileMentions
```

- [ ] **Step 3: Implement**

File: `apps/web/src/components/reconcileMentions.ts`

```ts
import type { MentionableUser } from '@primer/shared';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given a textarea body, the set of user IDs the typeahead has selected,
 * and the directory of known users, return the final submit-ready array
 * of user IDs whose `@<displayName>` substring still appears in the body.
 * This is the "delete by re-typing" safety net for the textarea-based
 * mention UX.
 */
export function reconcileMentions(
  body: string,
  selected: ReadonlySet<string>,
  users: ReadonlyArray<MentionableUser>,
): string[] {
  const out: string[] = [];
  for (const id of selected) {
    const u = users.find((x) => x.id === id);
    if (!u) continue;
    const pattern = new RegExp(`@${escapeRegex(u.displayName)}(?:\\b|\\s|$)`);
    if (pattern.test(body)) out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/web test reconcileMentions
pnpm --filter @primer/web typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reconcileMentions.ts apps/web/src/components/reconcileMentions.test.ts
git commit -m "feat(web): reconcileMentions pure helper"
git log --oneline -3
```

---

### Task 13: `MentionTextarea` component

**Files:**
- Create: `apps/web/src/components/MentionTextarea.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/MentionTextarea.tsx`

```tsx
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MentionableUser } from '@primer/shared';
import { useMentionableUsers } from '../queries/users.ts';
import { reconcileMentions } from './reconcileMentions.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Called with the final reconciled mention IDs whenever value changes. */
  onMentionsChange: (mentionIds: string[]) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  autoFocus?: boolean;
  /** Optional id for the underlying <textarea> (for label association). */
  id?: string;
  className?: string;
}

const POPOVER_MAX = 6;

export function MentionTextarea({
  value,
  onChange,
  onMentionsChange,
  placeholder,
  rows = 2,
  maxLength = 5000,
  autoFocus = false,
  id,
  className,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const usersQ = useMentionableUsers();
  const users: MentionableUser[] = usersQ.data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Typeahead state.
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  // Recompute reconciled mentions whenever body or selection changes.
  useEffect(() => {
    onMentionsChange(reconcileMentions(value, selected, users));
  }, [value, selected, users, onMentionsChange]);

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return users
      .filter((u) => u.displayName.toLowerCase().includes(q))
      .slice(0, POPOVER_MAX);
  }, [trigger, users]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    updateTrigger(next, e.target.selectionStart ?? next.length);
  }

  function updateTrigger(text: string, caret: number) {
    // Walk left from caret to the nearest @ or whitespace.
    let i = caret - 1;
    while (i >= 0 && text[i] !== '@' && !/\s/.test(text[i])) i--;
    if (i >= 0 && text[i] === '@') {
      const query = text.slice(i + 1, caret);
      // Cap the query at 40 chars to avoid pathological cases.
      if (query.length <= 40) {
        setTrigger({ start: i, query });
        setHighlightIdx(0);
        return;
      }
    }
    setTrigger(null);
  }

  function pick(u: MentionableUser) {
    if (!trigger || !taRef.current) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(taRef.current.selectionStart ?? value.length);
    const inserted = `@${u.displayName} `;
    const nextBody = `${before}${inserted}${after}`;
    onChange(nextBody);
    setSelected((s) => new Set(s).add(u.id));
    setTrigger(null);
    // Restore caret after the inserted mention.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = before.length + inserted.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!trigger || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTrigger(null);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setTrigger(null), 120)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        autoFocus={autoFocus}
        className={className ?? 'block w-full rounded border border-neutral-300 px-2 py-1 text-xs'}
      />
      {trigger && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-44 overflow-y-auto rounded border border-neutral-200 bg-white shadow-md"
        >
          {matches.map((u, idx) => (
            <li
              key={u.id}
              role="option"
              aria-selected={idx === highlightIdx}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                idx === highlightIdx ? 'bg-yellow-50' : ''
              }`}
            >
              <span className="font-medium text-neutral-800">{u.displayName}</span>
              <span className="ml-2 text-neutral-500">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/MentionTextarea.tsx
git commit -m "feat(web): MentionTextarea with @ typeahead popover"
git log --oneline -3
```

---

### Task 14: Wire `MentionTextarea` into composers + send `mentions` on submit

**Files:**
- Modify: `apps/web/src/components/NewThreadComposer.tsx`
- Modify: `apps/web/src/components/ThreadCard.tsx`
- Modify: `apps/web/src/queries/mutations.ts` (request body shape)

- [ ] **Step 1: Update `apps/web/src/queries/mutations.ts`**

Find the `useCreateThread`, `useReply`, and `useEditComment` mutations. Change their `mutationFn` signatures to accept and forward `mentions`:

```ts
// useCreateThread — change input type:
mutationFn: async (input: { anchor: AnchorData; body: string; mentions: string[] }) => {
  const res = await api(`/api/versions/${versionId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  // ...
}

// useReply:
mutationFn: async (input: { body: string; mentions: string[] }) => {
  const res = await api(`/api/threads/${threadId}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  // ...
}

// useEditComment:
mutationFn: async (input: { body: string; mentions: string[] }) => {
  const res = await api(`/api/comments/${commentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  // ...
}
```

(Some mutations may currently take just a `string` for body — change them to take the input object as shown.)

- [ ] **Step 2: Update `apps/web/src/components/NewThreadComposer.tsx`**

Find the existing `<textarea>` inside `NewThreadComposer`. Replace its plain JSX with `<MentionTextarea>` and track mentions:

```tsx
import { MentionTextarea } from './MentionTextarea.tsx';
// ...

// Inside the component:
const [body, setBody] = useState('');
const [mentions, setMentions] = useState<string[]>([]);

function handleSubmit() {
  if (body.trim().length === 0) return;
  onSubmit(body.trim(), mentions);  // changed signature — see below
}

// In the JSX where the <textarea> used to be:
<MentionTextarea
  value={body}
  onChange={setBody}
  onMentionsChange={setMentions}
  placeholder="Write a comment…"
  rows={2}
  autoFocus
/>
```

Also change the component's `onSubmit` prop type from `(body: string) => void` to `(body: string, mentions: string[]) => void`. Update wherever `NewThreadComposer` is mounted (likely in DocumentPage and CommentSidebar) — the call site provides a handler that calls `useCreateThread.mutate({ anchor, body, mentions })`.

- [ ] **Step 3: Update `apps/web/src/components/ThreadCard.tsx`**

Two composers in here — the reply form and the edit form. For each:

1. Replace the `<textarea>` with `<MentionTextarea>` (same pattern as Step 2).
2. Track `mentions` state alongside the draft.
3. When firing `reply.mutate(...)` / `edit.mutate(...)`, pass `{ body: draft.trim(), mentions }` instead of just the body string.

For the edit form, **prime the initial `mentions` state from `comment.mentions`** so editing a comment that already has mentions doesn't immediately wipe them:

```tsx
const [mentions, setMentions] = useState<string[]>(comment.mentions);
```

- [ ] **Step 4: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): composers use MentionTextarea, submit mentions[] alongside body"
git log --oneline -3
```

---

### Task 15: Render `@<Display Name>` spans inside saved comment bodies

**Files:**
- Create: `apps/web/src/components/renderMentions.tsx`
- Modify: `apps/web/src/components/ThreadCard.tsx`

- [ ] **Step 1: Create the renderer**

File: `apps/web/src/components/renderMentions.tsx`

```tsx
import type { ReactNode } from 'react';
import type { MentionableUser } from '@primer/shared';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a plain-text comment body, wrapping each `@<displayName>` substring
 * (for users in the supplied directory whose IDs appear in `mentions`) with
 * a styled span. Returns a React fragment with mixed text + spans.
 *
 * Imperfect: if the body contains the same display name twice but only one
 * was the typeahead pick, both get highlighted. Acceptable for an internal
 * tool where names aren't ambiguous in practice.
 */
export function renderMentions(
  body: string,
  mentions: string[],
  users: ReadonlyArray<MentionableUser>,
): ReactNode {
  const names = mentions
    .map((id) => users.find((u) => u.id === id)?.displayName)
    .filter((n): n is string => typeof n === 'string')
    .sort((a, b) => b.length - a.length); // longest first so prefixes don't shadow
  if (names.length === 0) return body;
  const pattern = new RegExp(`@(?:${names.map(escapeRegex).join('|')})`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(
      <span
        key={`${m.index}-${m[0]}`}
        className="rounded-sm bg-yellow-50 px-0.5 text-yellow-700"
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return <>{out}</>;
}
```

- [ ] **Step 2: Use the renderer in `ThreadCard`'s comment body rendering**

In `apps/web/src/components/ThreadCard.tsx`, find the line that renders the comment body (likely `<div ...>{comment.body}</div>`). Replace with the renderer:

```tsx
import { renderMentions } from './renderMentions.tsx';
import { useMentionableUsers } from '../queries/users.ts';

// Inside CommentRow (or the equivalent body-rendering block):
const usersQ = useMentionableUsers();
// ...
<div className="mt-0.5 leading-snug text-neutral-900">
  {renderMentions(comment.body, comment.mentions, usersQ.data ?? [])}
</div>
```

Edge case: when the mentionable-users query hasn't loaded yet, `renderMentions` returns the raw body (because `names` is empty). That's correct — the highlights appear after the user list arrives.

- [ ] **Step 3: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/renderMentions.tsx apps/web/src/components/ThreadCard.tsx
git commit -m "feat(web): render @<name> spans inside saved comment bodies"
git log --oneline -3
```

---

## Phase I — Sidebar lift-state-up + deep-link hash

### Task 16: `CommentSidebar` accepts controlled `collapsed` props

**Files:**
- Modify: `apps/web/src/components/CommentSidebar.tsx`

- [ ] **Step 1: Add optional controlled props**

Find the `Props` interface inside `CommentSidebar.tsx`. Add:

```ts
interface Props {
  // ... existing props ...
  collapsed?: boolean;
  onCollapsedChange?: (next: boolean) => void;
}
```

Then update the component to use them in controlled-vs-uncontrolled mode:

```tsx
const COLLAPSED_KEY = 'primer.sidebar.collapsed';

export function CommentSidebar({ collapsed: controlledCollapsed, onCollapsedChange, /* ...rest */ }: Props) {
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const isControlled = controlledCollapsed !== undefined;
  const collapsed = isControlled ? controlledCollapsed! : uncontrolledCollapsed;
  const setCollapsed = (next: boolean) => {
    if (isControlled) {
      onCollapsedChange?.(next);
    } else {
      setUncontrolledCollapsed(next);
    }
  };
  // The localStorage write only fires in uncontrolled mode; the controlled
  // caller is responsible for persistence.
  useEffect(() => {
    if (!isControlled && typeof window !== 'undefined') {
      window.localStorage.setItem(COLLAPSED_KEY, uncontrolledCollapsed ? '1' : '0');
    }
  }, [isControlled, uncontrolledCollapsed]);

  // ... rest of the component using `collapsed` and `setCollapsed` unchanged ...
}
```

Existing call sites that don't pass `collapsed`/`onCollapsedChange` continue to work in uncontrolled mode (no behaviour change).

- [ ] **Step 2: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/CommentSidebar.tsx
git commit -m "refactor(web): CommentSidebar accepts optional controlled collapsed props"
git log --oneline -3
```

---

### Task 17: `DocumentPage` owns collapsed state + hash-scroll effect

**Files:**
- Modify: `apps/web/src/routes/document.tsx`
- Modify: `apps/web/src/components/ThreadCard.tsx` (add stable `id` attribute)

- [ ] **Step 1: Give `ThreadCard` a stable DOM id**

In `apps/web/src/components/ThreadCard.tsx`, find the outermost `<article>` of `ThreadCard`. Add `id={\`thread-${thread.id}\`}`:

```tsx
<article id={`thread-${thread.id}`} className={/* existing */} onClick={/* existing */}>
```

- [ ] **Step 2: Lift collapsed state into `DocumentPage`**

In `apps/web/src/routes/document.tsx`, near the other `useState` declarations, add:

```tsx
const COLLAPSED_KEY = 'primer.sidebar.collapsed';
const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(COLLAPSED_KEY) === '1';
});
useEffect(() => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
}, [sidebarCollapsed]);
```

And pass them to `CommentSidebar`:

```tsx
<CommentSidebar
  // ... existing props ...
  collapsed={sidebarCollapsed}
  onCollapsedChange={setSidebarCollapsed}
/>
```

- [ ] **Step 3: Add the hash-scroll-and-highlight effect**

In `DocumentPage`, after the threads query and `onHighlight` are defined, add:

```tsx
useEffect(() => {
  const hash = window.location.hash;
  const match = hash.match(/^#thread-([a-f0-9-]+)$/i);
  if (!match) return;
  const threadId = match[1];
  if (!threadsQuery.isSuccess) return;
  const found = threads.find((t) => t.id === threadId);
  if (!found) return;

  setSidebarCollapsed(false);

  // Defer to next frame so the sidebar transition starts + the DOM is ready.
  requestAnimationFrame(() => {
    document.getElementById(`thread-${threadId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    onHighlight(threadId);
  });

  // Clear the hash so a manual refresh doesn't re-fire.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}, [threadsQuery.isSuccess, threads, onHighlight]);
```

(If `onHighlight` is defined inside the same component as a `useCallback`, the deps array is correct. If it's a stable function passed in elsewhere, adjust the deps.)

- [ ] **Step 4: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/document.tsx apps/web/src/components/ThreadCard.tsx
git commit -m "feat(web): DocumentPage owns sidebar collapsed; hash-scroll to thread on arrival"
git log --oneline -3
```

---

## Phase J — Verification + finalize

### Task 18: Cross-cutting verification

**Files:** none.

- [ ] **Step 1: `pnpm verify` + smoke**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm verify 2>&1 | tail -10
```

Expected: typecheck clean across all workspaces; ~185+ api tests + ~23 web tests green; `pnpm audit` clean.

- [ ] **Step 2: Boot smoke check (mock mode, no Resend key)**

```bash
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1
AUTH_MODE=mock pnpm dev > /tmp/primer-sp6-smoke.log 2>&1 &
PID=$!
sleep 6

echo "--- notifier startup ---"
grep -i 'notifier' /tmp/primer-sp6-smoke.log | tail -3
echo "--- /api/users/mentionable ---"
curl -s http://localhost:3000/api/users/mentionable | head -c 200
echo
echo "--- POST thread with mention (creates user-2 first via direct DB) ---"
docker compose exec -T postgres psql -U primer -d primer -c "INSERT INTO users (id, email, display_name) VALUES ('mock-user-2', 'two@p.t', 'User Two') ON CONFLICT (id) DO NOTHING;" >/dev/null
# (Actual mention-create flow uses the SPA; this is a smoke that the API accepts the new shape)

kill $PID 2>/dev/null
wait 2>/dev/null
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
```

Expected outputs:
- Log shows `notifier: Resend env incomplete, falling back to NoopNotifier`.
- `/api/users/mentionable` returns a JSON `{ users: [...] }` body (excluding mock-user-1).

- [ ] **Step 3: Commit history check**

```bash
git log --oneline master..HEAD | wc -l
git log --oneline -20
```

Expected: ~18 commits since branching from `0a009c7`.

- [ ] **Step 4: Apply any small fixes if anything failed**

Don't merge here — that's Task 19.

---

### Task 19: Final code review + squash merge

**Files:** none beyond branch deletion.

- [ ] **Step 1: Dispatch a final code reviewer** for the entire `master..feat/mentions-notifications` diff. Focus areas:
  - Mention validation correctness (every route, every code path: create, reply, edit). Self-removal happens, unknown IDs reject, cap enforced.
  - `notifyComment` is called exactly once per write path; fire-and-forget with `.catch(logger.error)`.
  - Edit diff sends only `newlyAdded`, not the full `cleanedMentions`. Edits with only removals don't fire at all.
  - ResendNotifier doesn't throw when a single recipient fails — it logs and continues.
  - Self-recipient is excluded even when accidentally in args.
  - `useMentionableUsers` is cached (`staleTime: 5 min`) and respects the api() wrapper (CSRF + 401 redirect).
  - `MentionTextarea` typeahead correctly handles edge cases: blur (popover dismisses), Escape (popover dismisses), Enter (selects + inserts), arrow keys (highlight cycle).
  - `reconcileMentions` regex escapes special characters in display names.
  - Sidebar still works in both uncontrolled (other call sites) and controlled (DocumentPage) modes.
  - Hash-scroll effect doesn't re-fire on every render (deps array correct + `history.replaceState` clears the hash).
  - `EMAIL_FROM`/`RESEND_API_KEY` missing → fallback to NoopNotifier with a warn log (not a hard fail).

- [ ] **Step 2: Apply small fixes** flagged as Important. Skip Minor.

- [ ] **Step 3: Squash-merge**

```bash
cd /home/taylan/development/polygon/primer
git checkout master
git merge --squash feat/mentions-notifications
git commit -m "$(cat <<'EOF'
Implement Primer sub-project 6: mentions + email notifications

Lights up the @-mention and email notification flow that has been
a no-op since SP3. Users can tag teammates in any comment composer
(new thread, reply, edit) and tagged or thread-participant users
receive a transactional email via Resend with a version-pinned
deep link that scrolls and highlights the target thread on
arrival.

API:
- Notifier interface collapsed to a single notifyComment method
  (NotifyCommentArgs carries both mentionedUserIds and
  participantUserIds). NoopNotifier and the new ResendNotifier
  both implement it.
- validateAndCleanMentions helper: rejects non-array input,
  unknown IDs, and over-25-mention inputs; silently removes the
  actor and deduplicates.
- POST /api/versions/:vid/threads, POST /api/threads/:tid/replies,
  PATCH /api/comments/:id all accept an optional mentions[]
  array, validate it, persist it onto comments.mentions, and fire
  fire-and-forget notifyComment. Edit semantics: only newly-added
  mentions trigger notifications; removals are silent. Replies
  compute prior thread participants (via the new partial index on
  comments(thread_id) WHERE deleted_at IS NULL) and union them
  with the new mentions for the notifier.
- GET /api/users/mentionable returns all users minus the caller
  for typeahead population.
- ResendNotifier per-recipient send loop: dedup across mention +
  reply sets, exclude actor, render signal-specific copy (mention
  only / reply only / both), POST to api.resend.com. Single
  recipient failure logs and continues.
- index.ts boots ResendNotifier when RESEND_API_KEY + EMAIL_FROM
  + AUTH_BASE_URL are set; otherwise NoopNotifier with a warn
  log.

Web:
- New MentionTextarea component with @-caret typeahead popover,
  arrow-key navigation, click + Enter insertion. Tracks selected
  user IDs in component state and emits the reconciled mentions
  array via onMentionsChange on every body edit (delete-by-
  re-typing safety net via reconcileMentions pure helper).
- useMentionableUsers query (TanStack Query, staleTime 5 min).
- NewThreadComposer and ThreadCard's reply + edit composers use
  MentionTextarea and submit { body, mentions } objects.
- renderMentions helper highlights @<Display Name> substrings in
  saved comment bodies (longest-name-first regex so prefixes
  don't shadow).
- CommentSidebar now accepts optional controlled collapsed +
  onCollapsedChange props (backwards-compatible). DocumentPage
  owns the state and persists to localStorage.
- DocumentPage has a hash-scroll effect: when the URL ends in
  #thread-<id>, opens the sidebar, scrolls the matching thread
  card into view, fires onHighlight to paint the iframe anchor,
  and clears the hash so refresh doesn't re-fire.

Tests: ~20 new API tests (validateAndCleanMentions, the new
/api/users/mentionable route, mention validation + notify
firing across all three write routes, ResendNotifier subject /
HTML / text rendering + per-recipient signal logic + actor
exclusion + transient 5xx handling) and 6 new web tests
(reconcileMentions). Final count: ~190 api + ~23 web.

No schema changes beyond a single partial index on
comments(thread_id) WHERE deleted_at IS NULL to speed up the
reply-participants lookup.

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
git branch -D feat/mentions-notifications
git branch -a
```

Expected: only `master` remains.

- [ ] **Step 6: Done.**

Next operational step (outside this plan): set Railway env vars `RESEND_API_KEY=<from your Resend dashboard>` and `EMAIL_FROM=primer@sequence-demos.xyz`, save → Railway auto-redeploys → check the deploy log for `notifier: Resend enabled`. Then send yourself a test mention and confirm the email lands with the right subject, body, and CTA URL.

---

## Notes for the implementer

- **`seedThreadWithComment` extension.** This helper is referenced in T7 + T8 with `authorId` + `mentions` parameters. If those parameters don't already exist on the helper, extend the signature with optional fields defaulted to today's defaults, so existing tests keep working. The helper likely lives near the top of `comments.test.ts` or `threads.test.ts`.
- **The spy notifier pattern** in T6–T8 builds a fresh `createApp(...)` with a manual `notifier: { notifyComment(args) { captured.push(args); } }` object instead of `NoopNotifier`. The harness's existing `withApp` doesn't expose this; rebuild the app inline in the test as shown.
- **`MentionTextarea` doesn't unit-test the typeahead state machine.** Frontend testing in this repo is limited; the state-machine logic is covered by `reconcileMentions.test.ts` (the pure half) plus manual testing in the dev browser. If a regression surfaces, that's where to add jsdom coverage.
- **Resend free tier limits.** 100 emails/day on the free tier is more than enough for an internal alpha. If usage scales, the upgrade path is a paid plan, not a code change.
- **`appBaseUrl` is `AUTH_BASE_URL`** — same env var, intentionally. Don't introduce a new `APP_BASE_URL` since they're guaranteed identical (the Okta callback origin = the app origin).
- **Doc title in subject is single-quoted, not double-quoted** so subjects with apostrophes don't escape weirdly in email clients. e.g. `User One commented on 'Q3 Planning'`. Acceptable for titles with their own apostrophes (`'Carol's Notes'`); HTML escape handles the HTML body separately.
