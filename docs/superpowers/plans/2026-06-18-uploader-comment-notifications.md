# Uploader Comment Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a comment is created on a Primer document, also email the document's uploader, in addition to @-mentioned users and prior thread participants.

**Architecture:** Add one optional-but-required-typed field (`uploaderUserId: string | null`) to the `NotifyCommentArgs` interface. The Mailgun notifier folds it into its recipient `Set` alongside mentions and participants, so dedup and self-skip happen for free. The two "new comment" route handlers extend their existing document SELECTs to pull `uploaderId` and forward it; the comment-edit path passes `null` (edits remain mentions-only). The shared email footer copy is broadened so the "why you're getting this" line stays accurate when the uploader is the sole reason.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vitest, Mailgun HTTP API.

**Reference design:** `docs/superpowers/specs/2026-06-18-uploader-comment-notifications-design.md`

**Test runner:** All test commands use the pnpm filter for the API package:
```
pnpm --filter @primer/api exec vitest run <path>
```
This avoids running the web and mcp suites for each iteration. The DB the API tests use must be migrated first — if you see schema errors, run `pnpm db:migrate:test` once.

---

## File Structure

**Modified:**
- `apps/api/src/notifications/notifier.ts` — add field to interface
- `apps/api/src/notifications/mailgun.ts` — fold uploader into recipients, update footer copy in both render functions
- `apps/api/src/notifications/notifier.test.ts` — extend ARGS fixture
- `apps/api/src/notifications/mailgun.test.ts` — extend `args()` helper; new test cases
- `apps/api/src/routes/threads.ts` — extend `latestRow` SELECT; pass `uploaderUserId`
- `apps/api/src/routes/threads.test.ts` — assert uploader is forwarded on new thread
- `apps/api/src/routes/comments.ts` — extend `threadCtx` SELECT in reply path; pass `null` in edit path
- `apps/api/src/routes/comments.test.ts` — assert uploader is forwarded on reply; assert null on edit

**Not modified:** Database schema, MCP package, web package, NoopNotifier implementation (the new field rides through the `logger.debug` call).

---

### Task 1: Add `uploaderUserId` field to the notifier interface and update all existing callers to pass `null`

This task is a type-level refactor with no behavior change. After it lands, TS compiles, all existing tests pass unchanged, and every call site is ready to be made meaningful in later tasks.

**Files:**
- Modify: `apps/api/src/notifications/notifier.ts:3-11`
- Modify: `apps/api/src/notifications/notifier.test.ts:4-12`
- Modify: `apps/api/src/notifications/mailgun.test.ts:10-21`
- Modify: `apps/api/src/routes/threads.ts:328-338`
- Modify: `apps/api/src/routes/comments.ts:215-225` and `apps/api/src/routes/comments.ts:298-308`

- [ ] **Step 1: Verify the baseline typechecks and tests pass**

Run:
```
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api exec vitest run src/notifications
```
Expected: both succeed. This is the "green" we start from.

- [ ] **Step 2: Add the field to `NotifyCommentArgs`**

In `apps/api/src/notifications/notifier.ts`, replace the interface with:

```ts
export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  uploaderUserId: string | null;
  actorUserId: string;
}
```

(`uploaderUserId` is required at the type level, nullable at the value level. Required-ness forces every caller to think about it.)

- [ ] **Step 3: Run typecheck — expect failures at every call site**

Run: `pnpm --filter @primer/api typecheck`
Expected: TS errors at:
- `apps/api/src/notifications/notifier.test.ts` (`ARGS` literal)
- `apps/api/src/notifications/mailgun.test.ts` (`args()` default literal)
- `apps/api/src/routes/threads.ts` (`notifyComment` call)
- `apps/api/src/routes/comments.ts` (two `notifyComment` calls)

This proves the interface change reaches every caller.

- [ ] **Step 4: Update the `NoopNotifier` test fixture**

In `apps/api/src/notifications/notifier.test.ts`, change the `ARGS` literal to include `uploaderUserId: null`:

```ts
const ARGS: NotifyCommentArgs = {
  doc: { id: 'doc-1', title: 'Test Doc' },
  version: { id: 'v-1', versionNumber: 1 },
  thread: { id: 't-1' },
  comment: { id: 'c-1', body: 'hi', createdAt: new Date() },
  mentionedUserIds: [],
  participantUserIds: [],
  uploaderUserId: null,
  actorUserId: 'mock-user-1',
};
```

- [ ] **Step 5: Update the `args()` helper in the Mailgun test**

In `apps/api/src/notifications/mailgun.test.ts`, change the `args()` helper to include `uploaderUserId: null` by default:

```ts
function args(over: Partial<NotifyCommentArgs> = {}): NotifyCommentArgs {
  return {
    doc: { id: 'doc-1', title: 'Test Doc' },
    version: { id: 'v-1', versionNumber: 3 },
    thread: { id: 'thread-abc' },
    comment: { id: 'c-1', body: 'hello @Alice', createdAt: NOW },
    mentionedUserIds: ['mock-user-2'],
    participantUserIds: [],
    uploaderUserId: null,
    actorUserId: 'mock-user-1',
    ...over,
  };
}
```

- [ ] **Step 6: Update the new-thread call site to pass `uploaderUserId: null` for now**

In `apps/api/src/routes/threads.ts`, the `notifyComment` block currently reads:

```ts
void deps.notifier
  .notifyComment({
    doc: { id: latestRow.doc_id, title: latestRow.doc_title },
    version: { id: latestRow.version_id, versionNumber: latestRow.this_n },
    thread: { id: threadId },
    comment: { id: commentId, body: bodyValidation.body, createdAt: insertedAt },
    mentionedUserIds: cleanedMentions,
    participantUserIds: [],
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId }, 'notifier failed'));
```

Add `uploaderUserId: null,` immediately above `actorUserId`. **This is a placeholder; Task 4 replaces it with the real uploader id.**

- [ ] **Step 7: Update the comments reply call site to pass `uploaderUserId: null` for now**

In `apps/api/src/routes/comments.ts:215-225`, the reply path call reads:

```ts
void deps.notifier
  .notifyComment({
    doc: { id: threadCtx.doc_id, title: threadCtx.doc_title },
    version: { id: threadCtx.version_id, versionNumber: threadCtx.version_number },
    thread: { id: threadId },
    comment: { id: commentId, body: validation.body, createdAt: insertedAt },
    mentionedUserIds: cleanedMentions,
    participantUserIds,
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId }, 'notifier failed'));
```

Add `uploaderUserId: null,` immediately above `actorUserId`. **Task 5 replaces this with the real uploader id.**

- [ ] **Step 8: Update the comments edit call site to pass `uploaderUserId: null` permanently**

In `apps/api/src/routes/comments.ts:298-308`, the edit path call reads:

```ts
void deps.notifier
  .notifyComment({
    doc: { id: editCtx.doc_id, title: editCtx.doc_title },
    version: { id: editCtx.version_id, versionNumber: editCtx.version_number },
    thread: { id: existing.threadId },
    comment: { id: commentId, body: validation.body, createdAt: existing.createdAt },
    mentionedUserIds: newlyAdded,
    participantUserIds: [],
    actorUserId: user.id,
  })
  .catch((err) => logger.error({ err, commentId }, 'notifier failed (edit)'));
```

Add `uploaderUserId: null,` immediately above `actorUserId`. **This stays `null` forever — edits never notify the uploader (per spec).**

- [ ] **Step 9: Run typecheck and the API tests**

Run:
```
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api exec vitest run
```
Expected: both pass cleanly. No behavior change, all callers know about the new field.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/notifications/notifier.ts \
  apps/api/src/notifications/notifier.test.ts \
  apps/api/src/notifications/mailgun.test.ts \
  apps/api/src/routes/threads.ts \
  apps/api/src/routes/comments.ts
git commit -m "refactor(notifier): add uploaderUserId field to NotifyCommentArgs

Adds the field at the type level and threads null through every existing
call site. No behavior change yet — Mailgun still routes only mentions
and participants. Follow-up tasks wire the field in the Mailgun notifier
and the two new-comment route handlers."
```

---

### Task 2: Mailgun — fold `uploaderUserId` into the recipient set

TDD: write a failing test asserting the uploader receives an email when not in any other list, then implement.

**Files:**
- Test: `apps/api/src/notifications/mailgun.test.ts` (new cases)
- Modify: `apps/api/src/notifications/mailgun.ts:99-104`

- [ ] **Step 1: Add the failing tests**

Append to the `describe('MailgunNotifier.notifyComment', ...)` block in `apps/api/src/notifications/mailgun.test.ts`:

```ts
it('emails the uploader even when they are not @-mentioned or a participant', async () => {
  const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
  await n.notifyComment(
    args({
      mentionedUserIds: [],
      participantUserIds: [],
      uploaderUserId: 'mock-user-2',
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(body.to).toBe('two@p.t');
});

it('dedups the uploader against mentions and participants (one email)', async () => {
  const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
  await n.notifyComment(
    args({
      mentionedUserIds: ['mock-user-2'],
      participantUserIds: ['mock-user-2'],
      uploaderUserId: 'mock-user-2',
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(body.to).toBe('two@p.t');
});

it('does not email the uploader when they are the actor (self-skip)', async () => {
  const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
  await n.notifyComment(
    args({
      mentionedUserIds: [],
      participantUserIds: [],
      uploaderUserId: 'mock-user-1',   // same as default actorUserId
    }),
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the new tests — expect the first to fail, the other two to pass trivially**

Run: `pnpm --filter @primer/api exec vitest run src/notifications/mailgun.test.ts`
Expected: the first new test (`emails the uploader even when they are not @-mentioned or a participant`) **fails** with `expected fetchMock to have been called 1 times`. The dedup and self-skip tests pass trivially before the patch (the set is already correct for those cases because uploader either coincides with an existing recipient or is the actor) and continue to pass after the patch — they are regression guards documenting intended behavior, not red-then-green checks. This asymmetry is fine; the first test is the one that drives the change.

- [ ] **Step 3: Implement — fold `uploaderUserId` into the recipient `Set`**

In `apps/api/src/notifications/mailgun.ts`, the `notifyComment` method starts with:

```ts
async notifyComment(args: NotifyCommentArgs): Promise<void> {
  const mentionSet = new Set(args.mentionedUserIds);
  const participantSet = new Set(args.participantUserIds);
  const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
  recipientIds.delete(args.actorUserId);
  if (recipientIds.size === 0) return;
```

Change it to:

```ts
async notifyComment(args: NotifyCommentArgs): Promise<void> {
  const mentionSet = new Set(args.mentionedUserIds);
  const participantSet = new Set(args.participantUserIds);
  const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
  if (args.uploaderUserId) recipientIds.add(args.uploaderUserId);
  recipientIds.delete(args.actorUserId);
  if (recipientIds.size === 0) return;
```

The `add` happens before `delete`, so an uploader who is also the actor gets removed correctly. `if (args.uploaderUserId)` guards against `null` and against the empty string.

- [ ] **Step 4: Run the tests — expect all green**

Run: `pnpm --filter @primer/api exec vitest run src/notifications/mailgun.test.ts`
Expected: all tests pass, including the new three and the existing nine.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications/mailgun.ts \
  apps/api/src/notifications/mailgun.test.ts
git commit -m "feat(notifier): include document uploader in Mailgun recipients

The Mailgun notifier now adds args.uploaderUserId to its recipient set
alongside mentions and participants. Dedup is automatic (Set), and the
actor-skip happens after the add so uploader == actor is handled."
```

---

### Task 3: Mailgun — broaden email copy (lead line AND footer) so uploader-only recipients see accurate copy

The opening line of every email comes from `signalLead(actorName, mention, reply)`. When a recipient is the uploader but neither @-mentioned nor a prior participant, the current fallback says "${actorName} replied to a thread you're in." — which is false (they haven't been replied to). Task 3 fixes both the opening line and the footer so uploader-only recipients see accurate copy.

**Files:**
- Test: `apps/api/src/notifications/mailgun.test.ts` (two new cases; broadened-but-backward-compatible expectations for the existing `mention-only` / `reply-only` / `combined` tests stay valid)
- Modify: `apps/api/src/notifications/mailgun.ts` — `signalLead`, `renderText`, `renderHtml`, and the per-recipient call site in `notifyComment` that computes `mention` and `reply`

- [ ] **Step 1: Add the failing tests**

Append to `describe('MailgunNotifier.notifyComment', ...)` in `apps/api/src/notifications/mailgun.test.ts`:

```ts
it('renders uploader-only lead copy (no mention, no participation)', async () => {
  const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
  await n.notifyComment(
    args({
      mentionedUserIds: [],
      participantUserIds: [],
      uploaderUserId: 'mock-user-2',
    }),
  );
  const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(body.text).toContain('commented on a document you uploaded');
  expect(body.text).not.toContain("replied to a thread you're in");
  expect(body.text).not.toContain('mentioned you');
});

it('renders an uploader-aware footer in both text and HTML', async () => {
  const n = new MailgunNotifier({ apiKey: 'k', domain: 'd.x', fromAddress: 'p@d.x', appBaseUrl: 'https://p.x' });
  await n.notifyComment(args());
  const body = parseForm((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  const expected = 'You received this because you were mentioned, are a participant in this thread, or uploaded this document.';
  expect(body.text).toContain(expected);
  expect(body.html).toContain(expected);
});
```

The existing `'renders mention-only signal copy'`, `'renders reply-only signal copy'`, and `'renders combined signal copy'` tests must continue to pass without modification — `signalLead` keeps its current outputs in the no-uploader cases.

- [ ] **Step 2: Run the new tests — expect both to fail**

Run: `pnpm --filter @primer/api exec vitest run src/notifications/mailgun.test.ts`
Expected:
- `renders uploader-only lead copy` fails because the current fallback returns `"… replied to a thread you're in."` for `!mention && !reply`.
- `renders an uploader-aware footer in both text and HTML` fails because the current footer string is the old phrasing.

- [ ] **Step 3: Update `signalLead` to take an `uploaded` flag**

In `apps/api/src/notifications/mailgun.ts`, replace `signalLead`:

```ts
function signalLead(actorName: string, mention: boolean, reply: boolean, uploaded: boolean): string {
  if (mention && reply) {
    return uploaded
      ? `${actorName} mentioned you and replied to a thread on a document you uploaded.`
      : `${actorName} mentioned you and replied to a thread you're in.`;
  }
  if (mention) {
    return uploaded
      ? `${actorName} mentioned you in a comment on a document you uploaded.`
      : `${actorName} mentioned you in a comment.`;
  }
  if (reply) {
    return uploaded
      ? `${actorName} replied to a thread on a document you uploaded.`
      : `${actorName} replied to a thread you're in.`;
  }
  // uploaded-only: no mention, not in the thread, but they uploaded the doc.
  return `${actorName} commented on a document you uploaded.`;
}
```

The three pre-uploader cases (`mention && reply`, `mention`, `reply`) keep their existing copy when `uploaded === false`, so the existing tests stay green.

- [ ] **Step 4: Update `renderText` to accept and forward `uploaded`, and update the footer**

```ts
function renderText(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
  uploaded: boolean,
): string {
  return [
    signalLead(actorName, mention, reply, uploaded),
    '',
    `Doc: ${docTitle}`,
    '',
    commentExcerpt,
    '',
    `Open thread: ${url}`,
    '',
    'You received this because you were mentioned, are a participant in this thread, or uploaded this document.',
  ].join('\n');
}
```

- [ ] **Step 5: Update `renderHtml` to accept and forward `uploaded`, and update the footer**

```ts
function renderHtml(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
  uploaded: boolean,
): string {
  const lead = escapeHtml(signalLead(actorName, mention, reply, uploaded));
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
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were mentioned, are a participant in this thread, or uploaded this document.</p>
  </td></tr>
</table>
</body></html>`;
}
```

Only the signature (added `uploaded` param), the `signalLead` call, and the footer `<p>` change. Everything else is byte-identical.

- [ ] **Step 6: Compute and pass `uploaded` per recipient in `notifyComment`**

In the per-recipient loop in `apps/api/src/notifications/mailgun.ts`:

```ts
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
```

Change it to:

```ts
for (const recipientId of recipientIds) {
  const recipient = rows.find((u) => u.id === recipientId);
  if (!recipient) {
    logger.warn({ recipientId }, 'recipient not found in users table, skipping');
    continue;
  }
  const mention = mentionSet.has(recipientId);
  const reply = participantSet.has(recipientId);
  const uploaded = args.uploaderUserId !== null && recipientId === args.uploaderUserId;
  const html = renderHtml(actorName, args.doc.title, excerpt, url, mention, reply, uploaded);
  const text = renderText(actorName, args.doc.title, excerpt, url, mention, reply, uploaded);
```

- [ ] **Step 7: Run the tests — expect all green**

Run: `pnpm --filter @primer/api exec vitest run src/notifications/mailgun.test.ts`
Expected: all tests pass (14 total: original 9 + Task 2's 3 + Task 3's 2). The existing `mention-only`, `reply-only`, and `combined` cases still pass because `signalLead`'s behavior for `uploaded === false` is unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/notifications/mailgun.ts \
  apps/api/src/notifications/mailgun.test.ts
git commit -m "feat(notifier): make email lead and footer accurate for uploader recipients

signalLead now takes an 'uploaded' boolean and renders an uploader-aware
opening line in all combinations (uploader-only, uploader+mention,
uploader+reply, uploader+mention+reply). Footer copy is broadened to
cover the uploader reason. Non-uploader cases keep their existing copy
so the mention-only / reply-only / combined assertions remain valid."
```

---

### Task 4: Threads route — pull `uploader_id` and pass it into `notifyComment`

TDD: add a test that seeds a doc whose uploader differs from the actor, drives the new-thread endpoint, and asserts the captured `uploaderUserId` matches. Then extend the SQL and wire it.

**Files:**
- Test: `apps/api/src/routes/threads.test.ts` (one new case)
- Modify: `apps/api/src/routes/threads.ts:266-283` (SELECT) and `apps/api/src/routes/threads.ts:328-339` (notifyComment payload)

- [ ] **Step 1: Add a `seedDocumentAs` helper for uploader-controlled seeds**

At the top of `apps/api/src/routes/threads.test.ts`, beside the existing `async function seedDocument()`, add:

```ts
async function seedDocumentAs(uploaderId: string) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed Doc',
    description: null,
    uploaderId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  return { documentId, versionId };
}
```

(`seedDocument()` stays untouched — its callers still want uploader = `mock-user-1`.)

- [ ] **Step 2: Add the failing test**

Append to the existing `describe(...)` that ends with the `'fires notifyComment with mentionedUserIds populated'` test in `apps/api/src/routes/threads.test.ts`:

```ts
it('forwards the document uploader id to notifyComment on a new thread', async () => {
  await db
    .insert(users)
    .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
    .onConflictDoNothing();

  const captured: { uploaderUserId: string | null; actorUserId: string }[] = [];
  const spyApp = createApp({
    storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-uploader-spy-'))),
    notifier: {
      async notifyComment(args: unknown) {
        captured.push(args as never);
      },
    } as never,
  });
  // Uploader is user-2; actor (default header) is user-1.
  const seed = await seedDocumentAs('mock-user-2');
  await spyApp.request(`/api/versions/${seed.versionId}/threads`, {
    method: 'POST',
    headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      body: 'first comment, no mentions',
      mentions: [],
    }),
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(captured).toHaveLength(1);
  expect(captured[0].uploaderUserId).toBe('mock-user-2');
  expect(captured[0].actorUserId).toBe('mock-user-1');
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `pnpm --filter @primer/api exec vitest run src/routes/threads.test.ts -t "forwards the document uploader id"`
Expected: failure on `expect(captured[0].uploaderUserId).toBe('mock-user-2')` — the route is still passing `null` (placeholder from Task 1).

- [ ] **Step 4: Extend the SQL to include `uploader_id`**

In `apps/api/src/routes/threads.ts:266-283`, the current SELECT reads:

```ts
const [latestRow] = (await db.execute(sql`
  SELECT MAX(v2.version_number)::int AS max_n,
         v.version_number::int AS this_n,
         v.id AS version_id,
         d.id AS doc_id,
         d.title AS doc_title
  FROM versions v
  INNER JOIN documents d ON d.id = v.document_id
  INNER JOIN versions v2 ON v2.document_id = d.id
  WHERE v.id = ${versionId}
  GROUP BY v.version_number, v.id, d.id, d.title
`)) as unknown as {
  max_n: number | null;
  this_n: number | null;
  version_id: string;
  doc_id: string;
  doc_title: string;
}[];
```

Change it to:

```ts
const [latestRow] = (await db.execute(sql`
  SELECT MAX(v2.version_number)::int AS max_n,
         v.version_number::int AS this_n,
         v.id AS version_id,
         d.id AS doc_id,
         d.title AS doc_title,
         d.uploader_id AS uploader_id
  FROM versions v
  INNER JOIN documents d ON d.id = v.document_id
  INNER JOIN versions v2 ON v2.document_id = d.id
  WHERE v.id = ${versionId}
  GROUP BY v.version_number, v.id, d.id, d.title, d.uploader_id
`)) as unknown as {
  max_n: number | null;
  this_n: number | null;
  version_id: string;
  doc_id: string;
  doc_title: string;
  uploader_id: string;
}[];
```

(Adding `d.uploader_id` to the GROUP BY is required because the projection already aggregates on `MAX(v2.version_number)`.)

- [ ] **Step 5: Forward `uploader_id` into the `notifyComment` call**

In `apps/api/src/routes/threads.ts:328-339`, change the placeholder `uploaderUserId: null` to:

```ts
uploaderUserId: latestRow.uploader_id,
```

- [ ] **Step 6: Run the new test plus the rest of the routes suite**

Run:
```
pnpm --filter @primer/api exec vitest run src/routes/threads.test.ts
```
Expected: all pass, including the new uploader-forwarding test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/threads.ts \
  apps/api/src/routes/threads.test.ts
git commit -m "feat(threads): forward document uploader id to comment notifier

The new-thread endpoint now reads d.uploader_id alongside doc/version
metadata and passes it as uploaderUserId. The notifier already does the
right thing (recipient set + dedup + self-skip)."
```

---

### Task 5: Comments reply route — pull `uploader_id` and pass it into `notifyComment`

TDD: same shape as Task 4 but for the reply endpoint. Also assert the edit path still sends `null` (regression guard for the "edits don't notify uploader" decision).

**Files:**
- Test: `apps/api/src/routes/comments.test.ts` (two new cases)
- Modify: `apps/api/src/routes/comments.ts:149-162` (SELECT) and `apps/api/src/routes/comments.ts:215-226` (notifyComment payload)

- [ ] **Step 1: Add an uploader-controlled seed helper for the comments tests**

In `apps/api/src/routes/comments.test.ts`, beside the existing `seedDocVersionThread`, add:

```ts
async function seedDocVersionThreadAs({
  uploaderId,
  authorId = 'mock-user-1',
}: { uploaderId: string; authorId?: string }) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  const threadId = uuidv7();
  const commentId = uuidv7();
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
    versionNote: null,
  });
  await db.insert(threads).values({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
  });
  await db.insert(comments).values({
    id: commentId,
    threadId,
    authorId,
    body: 'seed',
    mentions: [],
  });
  return { documentId, versionId, threadId, commentId };
}
```

(The existing `seedDocVersionThread` is unchanged — its uploader stays `mock-user-1` for back-compat with current tests.)

- [ ] **Step 2: Add the failing tests**

Append to the `describe('POST /api/threads/:tid/comments — mentions', ...)` block in `apps/api/src/routes/comments.test.ts`:

```ts
it('forwards the document uploader id to notifyComment on a reply', async () => {
  await db
    .insert(users)
    .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
    .onConflictDoNothing();
  // Uploader is user-2; the first comment author is also user-2 so user-1's reply is the only new event.
  const { threadId } = await seedDocVersionThreadAs({ uploaderId: 'mock-user-2', authorId: 'mock-user-2' });

  const captured: { uploaderUserId: string | null; actorUserId: string }[] = [];
  const spyApp = createApp({
    storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-reply-uploader-spy-'))),
    notifier: {
      async notifyComment(args: unknown) {
        captured.push(args as never);
      },
    } as never,
  });

  const res = await spyApp.request(`/api/threads/${threadId}/comments`, {
    method: 'POST',
    headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'plain reply, no mentions' }),
  });
  expect(res.status).toBe(201);
  await new Promise((r) => setTimeout(r, 50));
  expect(captured).toHaveLength(1);
  expect(captured[0].uploaderUserId).toBe('mock-user-2');
  expect(captured[0].actorUserId).toBe('mock-user-1');
});
```

And in the `describe('PATCH /api/comments/:cid', ...)` block, append:

```ts
it('passes uploaderUserId: null to notifyComment on edit (edits never notify the uploader)', async () => {
  await db
    .insert(users)
    .values([
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
      { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
    ])
    .onConflictDoNothing();
  // Uploader is user-2; the comment author (editor) is user-1.
  const { commentId } = await seedDocVersionThreadAs({ uploaderId: 'mock-user-2', authorId: 'mock-user-1' });

  const captured: { uploaderUserId: string | null }[] = [];
  const spyApp = createApp({
    storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-uploader-spy-'))),
    notifier: {
      async notifyComment(args: unknown) {
        captured.push(args as never);
      },
    } as never,
  });

  // An edit that adds a new mention so notifyComment actually fires.
  const res = await spyApp.request(`/api/comments/${commentId}`, {
    method: 'PATCH',
    headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ body: '@Three look', mentions: ['mock-user-3'] }),
  });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));
  expect(captured).toHaveLength(1);
  expect(captured[0].uploaderUserId).toBeNull();
});
```

- [ ] **Step 3: Run the new tests — expect failure on the reply test**

Run: `pnpm --filter @primer/api exec vitest run src/routes/comments.test.ts -t "uploader id"`
Expected: the reply test fails (`uploaderUserId` is `null` from Task 1's placeholder); the edit test passes (the edit path already passes `null` permanently). This is the asymmetry we want.

- [ ] **Step 4: Extend the reply-path SQL to include `uploader_id`**

In `apps/api/src/routes/comments.ts:149-162`, the current SELECT reads:

```ts
const [threadCtx] = (await db.execute(sql`
  SELECT d.id AS doc_id, d.title AS doc_title,
         v.id AS version_id, v.version_number::int AS version_number
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

Change it to:

```ts
const [threadCtx] = (await db.execute(sql`
  SELECT d.id AS doc_id, d.title AS doc_title,
         d.uploader_id AS uploader_id,
         v.id AS version_id, v.version_number::int AS version_number
  FROM threads t
  INNER JOIN versions v ON v.id = t.version_id
  INNER JOIN documents d ON d.id = v.document_id
  WHERE t.id = ${threadId}
  LIMIT 1
`)) as unknown as Array<{
  doc_id: string;
  doc_title: string;
  uploader_id: string;
  version_id: string;
  version_number: number;
}>;
```

- [ ] **Step 5: Forward `uploader_id` into the reply-path `notifyComment` call**

In `apps/api/src/routes/comments.ts:215-226`, replace the placeholder `uploaderUserId: null` with:

```ts
uploaderUserId: threadCtx.uploader_id,
```

The edit-path call site (around line 298) stays `uploaderUserId: null`. Do **not** touch the edit-path SELECT (`editCtx`) — it does not need `uploader_id`.

- [ ] **Step 6: Run the comments tests**

Run: `pnpm --filter @primer/api exec vitest run src/routes/comments.test.ts`
Expected: all pass, including the two new tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/comments.ts \
  apps/api/src/routes/comments.test.ts
git commit -m "feat(comments): forward document uploader id to comment notifier

The reply endpoint now reads d.uploader_id alongside doc/version metadata
and passes it as uploaderUserId. The edit endpoint deliberately keeps
uploaderUserId: null — edits never notify the uploader."
```

---

### Task 6: Full-suite verification

This task confirms nothing else regressed and the typecheck is clean.

- [ ] **Step 1: Run the full API test suite**

Run: `pnpm --filter @primer/api exec vitest run`
Expected: all green.

- [ ] **Step 2: Typecheck every package**

Run: `pnpm typecheck`
Expected: all green. (This catches shared/schema or web-side type leaks; none expected, but the check is cheap.)

- [ ] **Step 3: Run the workspace verify script if available**

Run: `pnpm verify`
Expected: typecheck + tests + audit all pass. (If `pnpm audit --audit-level=high` flags an unrelated CVE, surface it but don't block this plan on it.)

- [ ] **Step 4: Sanity-check the diff against the spec**

Re-read `docs/superpowers/specs/2026-06-18-uploader-comment-notifications-design.md` and walk through:
- `NotifyCommentArgs` has `uploaderUserId: string | null` ✓
- `MailgunNotifier` adds it to the recipient `Set` and respects self-skip + dedup ✓
- Footer copy in both `renderText` and `renderHtml` updated ✓
- `threads.ts` new-thread path forwards real uploader id ✓
- `comments.ts` reply path forwards real uploader id ✓
- `comments.ts` edit path forwards `null` ✓
- No DB schema change ✓

- [ ] **Step 5: Final status check — no extra commits or stray files**

Run: `git status` and `git log --oneline -10`
Expected: working tree clean. Five new commits on the branch (one per Task 1–5). No untracked files in `apps/api/src/notifications/` or `apps/api/src/routes/`.

The feature is complete and ready for whatever integration path the user prefers (PR, merge to master, etc.). Per repo convention, do not push without explicit instruction.
