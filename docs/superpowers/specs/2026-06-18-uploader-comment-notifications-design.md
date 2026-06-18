# Email Uploader on Every Comment — Design

**Date:** 2026-06-18
**Status:** Approved

## Goal

When someone posts a comment on a document, email the document's uploader. Today the comment-notification system emails only users who were @-mentioned or who previously commented in the same thread (participants). Uploaders are silently excluded unless they happen to fall into one of those buckets.

This change adds the uploader as a third recipient class on **new comments** (new threads and replies). Edits are not touched.

## Non-goals

- **No new "owner" concept on documents.** The `documents` table already has `uploaderId`; we use that. No schema migration.
- **No per-document or per-user opt-out.** The behavior is unconditional. Primer is a small internal tool; if this turns out to be too loud, an opt-out can be added later.
- **No change to edits.** `PATCH /api/comments/:id` continues to notify only newly-added @-mentions. Editing a typo on someone else's document does not ping the uploader.
- **No change to resolve / reopen / delete flows.** Those don't currently fire `notifyComment`.
- **No separate email template for uploader-only recipients.** The existing render functions are reused; only the per-recipient `signalLead` opening line gains a new `uploaded` boolean (so uploader-only recipients see "commented on a document you uploaded" instead of the misleading "replied to a thread you're in"), and the static footer line is broadened. The HTML/text layout, subject, and excerpt formatting are unchanged.

## Architecture

### Notifier interface (`apps/api/src/notifications/notifier.ts`)

Add an optional field to `NotifyCommentArgs`:

```ts
export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  uploaderUserId: string | null;   // NEW — document uploader, if any
  actorUserId: string;
}
```

`uploaderUserId` is kept separate from `participantUserIds` for two reasons:
1. **Semantics.** "Participant" means "posted in this thread." The uploader hasn't necessarily done that. Conflating them makes the routes lie about what they're passing.
2. **Future-proofing.** If we ever want differentiated copy or analytics ("you're getting this because you uploaded the doc"), we already have the data separated. Folding into `participantUserIds` would force us to re-split later.

`null` is permitted so that test fixtures and any future callers without a known uploader stay valid.

### Mailgun notifier (`apps/api/src/notifications/mailgun.ts`)

In `MailgunNotifier.notifyComment`, fold `uploaderUserId` into the recipient set alongside mentions and participants:

```ts
const mentionSet = new Set(args.mentionedUserIds);
const participantSet = new Set(args.participantUserIds);
const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
if (args.uploaderUserId) recipientIds.add(args.uploaderUserId);
recipientIds.delete(args.actorUserId);
if (recipientIds.size === 0) return;
```

Dedup is automatic because `recipientIds` is a Set: if the uploader is also @-mentioned or already a participant, they receive one email, not two or three. Self-skip is automatic because we always `delete(actorUserId)` after building the set — if the uploader posts a comment on their own doc, they don't email themselves.

### Email copy (opening line and footer)

Two complementary copy changes:

**1. `signalLead` (per-recipient opening line) gains an `uploaded` boolean.**
The current helper returns `${actor} replied to a thread you're in.` as the fallback for `!mention && !reply` — which is factually wrong when the only reason a recipient is being emailed is that they uploaded the doc (they have not been replied to). The new shape:

```ts
signalLead(actorName, mention, reply, uploaded)
```

renders accurate copy for all combinations:

- mention + reply + uploaded → "… mentioned you and replied to a thread on a document you uploaded."
- mention + uploaded → "… mentioned you in a comment on a document you uploaded."
- reply + uploaded → "… replied to a thread on a document you uploaded."
- uploaded only → "… commented on a document you uploaded."
- (existing combos when `uploaded === false` keep their current copy — important for back-compat with the existing mention-only / reply-only / combined tests).

`uploaded` is computed per recipient inside the `notifyComment` loop:

```ts
const uploaded = args.uploaderUserId !== null && recipientId === args.uploaderUserId;
```

**2. The static footer line in both `renderText` and `renderHtml`:**

> "You received this because you were mentioned or are a participant in this Primer thread."

becomes:

> "You received this because you were mentioned, are a participant in this thread, or uploaded this document."

The footer stays static (not per-recipient) — the differentiated logic is in `signalLead`. The footer is just a "your possible reasons" disclaimer.

### Route plumbing

Two call sites need to pass the uploader. Both already fetch document context for the notifier; we just extend the SELECT.

**`apps/api/src/routes/threads.ts:266-283`** — the "new thread" path. The existing query joins `documents`; add `d.uploader_id` to the projection and pass it through:

```ts
SELECT MAX(v2.version_number)::int AS max_n,
       v.version_number::int AS this_n,
       v.id AS version_id,
       d.id AS doc_id,
       d.title AS doc_title,
       d.uploader_id AS uploader_id
FROM versions v
...
```

Then in the `notifyComment` call:

```ts
uploaderUserId: latestRow.uploader_id,
```

**`apps/api/src/routes/comments.ts:149-162`** — the "reply" path. Same change: add `d.uploader_id AS uploader_id` to the existing `threadCtx` SELECT and forward it.

**`apps/api/src/routes/comments.ts:282-295`** — the "edit" path. Untouched. Pass `uploaderUserId: null` to satisfy the new field (edits already only fire on newly-added mentions, and we explicitly decided not to expand that).

### `NoopNotifier`

No code change needed — it accepts `NotifyCommentArgs` and logs. The new field rides along for free.

## Testing

### Unit — `apps/api/src/notifications/mailgun.test.ts`

Add cases:

1. **Uploader receives an email when uploader is neither mentioned nor a participant.** Args: `mentionedUserIds: []`, `participantUserIds: []`, `uploaderUserId: 'mock-user-2'`, `actorUserId: 'mock-user-1'`. Expect one mail to user-2.
2. **Uploader is deduped when also @-mentioned.** Args: `mentionedUserIds: ['mock-user-2']`, `participantUserIds: []`, `uploaderUserId: 'mock-user-2'`. Expect exactly one mail to user-2 (not two).
3. **Uploader self-skip.** Args: `uploaderUserId: 'mock-user-1'`, `actorUserId: 'mock-user-1'`, no mentions/participants. Expect zero mails.
4. **Footer copy.** Existing tests that check the rendered footer text get updated to the new string.

### Unit — `apps/api/src/routes/threads.test.ts`

The existing `'fires notifyComment with mentionedUserIds populated'` test gets extended (or a sibling test added) to assert `uploaderUserId` is passed and equals the document's uploader id.

### Unit — `apps/api/src/routes/comments.test.ts`

The existing reply tests get a sibling test asserting `uploaderUserId` flows through on `POST /api/threads/:threadId/comments`. The edit test gets an assertion that `uploaderUserId` is `null` on the edit-path `notifyComment` invocation.

### Integration

No new integration test layer. The Mailgun notifier's behavior is exercised by its unit tests with a `fetch` mock; the routes' behavior is exercised by their existing in-process tests with a recording `notifyComment` stub.

## Risk & Rollback

The change is additive at the interface level (a new optional-ish field — required at the type level but `null` is legal) and additive at the recipient set (one more id may be added; Set dedup ensures no duplicates). Worst case if something is wrong: the uploader gets too many or too few emails for a window. Rolling back is a single revert.
