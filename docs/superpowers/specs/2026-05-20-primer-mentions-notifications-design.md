# Primer Sub-Project 6 — Mentions + Email Notifications (design spec)

**Status:** approved, ready for implementation plan
**Date:** 2026-05-20
**Predecessor specs:** [SP5 auth + ownership](./2026-05-18-primer-auth-ownership-design.md), [SP3 comments + threading](./2026-05-16-primer-comments-threading-design.md)

## Goal

Wire the mention-and-reply notification flow that's been a no-op since SP3. Users can @-tag teammates inside any comment composer (new thread, reply, edit), and tagged or thread-participant users receive an email — sent via Resend — with a deep link back to the exact version + thread. The notifier ships as a swappable interface so a future `SlackNotifier` can drop in without touching the route layer.

This is the second sub-project in Phase 2, depending on SP5 for real user identities and email addresses populated from Okta claims.

## Non-goals

See [Section 7 — Out of scope](#section-7--out-of-scope). Headline exclusions: no Slack channel (the interface allows it later), no Okta directory typeahead (only signed-in users appear in `@` lookup), no per-user notification preferences, no sent-log table, no retry on transient Resend failure, no in-app notification badge.

---

## Section 1 — Architecture overview

```
Browser (comment composer)
    │   typeahead picks: { id: 'mock-user-2', displayName: 'Alice Tester' }
    │   inserts "@Alice Tester " into the textarea + tracks ['mock-user-2']
    │
    ▼   POST /api/versions/:vid/threads
        body: { anchor, body: "@Alice Tester can you check…", mentions: ['mock-user-2'] }
    │
    ▼
Hono route handler
    1. validate mentions[]: each id must exist in users + must not be the actor
    2. persist thread + comment (existing flow), set comments.mentions = mentions[]
    3. return 201 to the client (response done — UI gets fast feedback)
    4. fire-and-forget:
       void deps.notifier.notifyComment({
         doc, version, thread, comment,
         mentionedUserIds:   [validated array, minus actor],
         participantUserIds: [prior thread participants, minus actor, minus mentioned],
         actorUserId,
       }).catch(err => logger.error({err}, 'notifier failed'));
    │
    ▼
ResendNotifier.notifyComment(args)
    1. union recipients = mentionedUserIds ∪ participantUserIds (dedup)
    2. per recipient: fetch user row → email
    3. compute signal flag per recipient (mention? reply? both?)
    4. render subject + body (HTML + plain-text)
    5. one Resend API call per recipient
    6. log success/failure per recipient
```

**Shift from the SP3 placeholder interface:** the two methods (`notifyMentions`, `notifyReplyParticipants`) collapse into one `notifyComment` because the route knows both signal sets and can hand them over together. Per-recipient dedup happens inside the notifier impl.

**On edits:** `PATCH /api/comments/:id` diffs the new `mentions[]` against the persisted `mentions[]`. Only newly-added IDs fire `notifyComment` (with `participantUserIds: []` so the email is purely a mention). Removed mentions are silent — PRD-confirmed behaviour.

**On replies:** existing thread participants are computed by `SELECT DISTINCT author_id FROM comments WHERE thread_id = $1 AND deleted_at IS NULL`, then minus the actor and the newly-mentioned set.

---

## Section 2 — Data model

**No schema changes to existing tables.** The columns we need already exist:

- `comments.mentions text[] not null default '[]'` — added in SP3, currently always empty. SP6 starts populating it from request bodies.
- `users.email text not null` — populated by SP5 from Okta's `email` claim on first sign-in.

**One new index** for the reply-participants query:

```sql
CREATE INDEX comments_thread_id_idx ON comments (thread_id) WHERE deleted_at IS NULL;
```

Partial index because the participant query always filters `deleted_at IS NULL`. Drizzle generates the migration as a new file under `apps/api/drizzle/`.

**No sent-notifications table.** Fire-and-forget tolerates duplicate sends because the notifier is only called once per comment write. No retry, no idempotency check needed.

---

## Section 3 — API surface

**Three existing routes** thread the `mentions` array through. **One new route** for typeahead.

### Modified routes

`POST /api/versions/:vid/threads` (create thread + first comment) and `POST /api/threads/:tid/replies` (add reply):

```ts
// Request body adds one optional field:
{
  anchor: AnchorData,           // (POST threads only)
  body: string,                 // unchanged
  mentions?: string[],          // NEW: user IDs to mention
}
```

Server-side validation (defense-in-depth — frontend tracks but we don't trust it):
- Every ID in `mentions[]` must resolve to a row in `users`. Unknown IDs → 400 `invalid_mention`.
- Cap at 25 mentions per comment. Beyond that → 400 `too_many_mentions`.
- Self-mentions silently dropped from the array before persistence.

Persisted `comments.mentions` is the cleaned, validated, deduplicated array.

`PATCH /api/comments/:id` (edit): same `mentions?: string[]` field. Server computes the diff (`new ∖ old`); only the diff fires notifications. Stored value becomes the new array as-is; no history of removed mentions.

### Notifier hook firing

Routes call a single `notifyComment` after the DB write returns, fire-and-forget:

```ts
void deps.notifier.notifyComment({
  doc, version, thread, comment,
  mentionedUserIds: newMentions,        // for edits: diff only
  participantUserIds: priorParticipants, // [] for edits
  actorUserId: user.id,
}).catch((err) => logger.error({ err, commentId: comment.id }, 'notifier failed'));
```

### Notifier interface change

`apps/api/src/notifications/notifier.ts`:

```ts
export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];   // recipients flagged with the "mention" signal
  participantUserIds: string[]; // recipients flagged with the "reply" signal
  actorUserId: string;
}

export interface Notifier {
  notifyComment(args: NotifyCommentArgs): Promise<void>;
}
```

Old two-method interface dropped. `NoopNotifier` updated to match. Existing tests asserting on `notifyMentions` / `notifyReplyParticipants` get refactored to `notifyComment`.

### New route

`GET /api/users/mentionable` — returns the full list of `users` rows minus the current user, used by the typeahead. Shape:

```ts
{ users: Array<{ id: string; displayName: string; email: string }> }
```

Cached client-side with TanStack Query's `staleTime: 5 * 60 * 1000`. No server-side filtering — the list is small (Polygon employees who've opened Primer).

---

## Section 4 — Frontend tagging UX

### New component: `MentionTextarea`

Replaces the plain `<textarea>` in `NewThreadComposer`, the reply composer in `ThreadCard`, and the edit composer in `CommentRow`.

**Behaviour:**

- Typing `@` opens a typeahead popover anchored at the caret. Popover lists users from `useMentionableUsers()`, filtered client-side by prefix on `displayName` (case-insensitive) as the user keeps typing.
- Up/Down arrow + Enter selects, or click selects.
- Selecting inserts the literal text `@<Display Name> ` (trailing space) at the caret and pushes the user ID into a component-state `mentions: Set<string>`.
- Escape or clicking outside dismisses the popover without inserting.
- Backspacing through a mention chunk works character-by-character. No token-aware editor logic.

**Reconciliation on submit:** before posting, the component scans the final body text against the tracked Set. For each tracked user, if `@<Display Name>` no longer appears as a substring in the body, drop their ID. This is the safety net for the common case where someone backspaces over a mention. False positives if someone literally types `@Alice Tester` without using the typeahead — they get the mention; acceptable for an internal tool with non-ambiguous display names.

### Rendering (in saved comments + composer preview)

Plain text body. A regex pass wraps `@<Display Name>` substrings (for each name in `comment.mentions` resolved via the users API) in a styled span: `text-yellow-700 bg-yellow-50 px-0.5 rounded-sm`. Same regex logic in composer preview and saved comment view to keep behaviour consistent.

### Files added/modified

- **New** — `apps/web/src/components/MentionTextarea.tsx`
- **Modified** — `apps/web/src/components/NewThreadComposer.tsx` (swap textarea, pass mentions to submit)
- **Modified** — `apps/web/src/components/ThreadCard.tsx` (reply + edit composers, rendering pass)
- **New** — `apps/web/src/queries/users.ts` with `useMentionableUsers()`
- **New** — `apps/api/src/routes/users.ts` with `registerUserRoutes`
- **Modified** — `apps/api/src/app.ts` (register new route)

---

## Section 5 — Resend notifier impl

### New file: `apps/api/src/notifications/resend.ts`

`class ResendNotifier implements Notifier`, constructed with `{ apiKey, fromAddress, appBaseUrl }`. Wired in `apps/api/src/index.ts` with the env-driven pattern used by `OpenIdClientAdapter`:

```
EMAIL_FROM=primer@sequence-demos.xyz
RESEND_API_KEY=<from your Resend dashboard>
```

If either is missing at boot, fall back to `NoopNotifier` with a `logger.warn(...)`. Tests pass `NoopNotifier` directly so they never need a real key.

### `notifyComment(args)` logic

```ts
// 1. Build recipient set with per-recipient signal flags.
const mentionSet = new Set(args.mentionedUserIds);
const participantSet = new Set(args.participantUserIds);
const recipientIds = new Set([...mentionSet, ...participantSet]);
recipientIds.delete(args.actorUserId);  // defense-in-depth: no self

// 2. Fetch user rows (recipients + actor for the "from name").
const rows = await db.select(...).from(users).where(inArray(users.id, [...recipientIds, args.actorUserId]));
const actor = rows.find(u => u.id === args.actorUserId);

// 3. Per recipient: compute signal, render, send.
for (const recipientId of recipientIds) {
  const recipient = rows.find(u => u.id === recipientId);
  if (!recipient) continue;
  const signal = {
    mention: mentionSet.has(recipientId),
    reply: participantSet.has(recipientId),
  };
  await this.send(
    recipient.email,
    renderSubject(args, actor),
    renderHtml(args, actor, signal),
    renderText(args, actor, signal),
  );
}
```

### Email content

**Subject:** `"<Actor Name> commented on '<Doc Title>'"` (doc title truncated at 50 chars with ellipsis).

**Body lead by signal:**
- mention only → `"<Actor> mentioned you in a comment."`
- reply only → `"<Actor> replied to a thread you're in."`
- both → `"<Actor> mentioned you and replied to a thread you're in."`

**Followed by:**
- Comment excerpt: first 280 chars of `comment.body`, escaped + line-wrapped.
- CTA button → `${appBaseUrl}/d/${doc.id}/v/${version.versionNumber}#thread-${thread.id}`
- Footer line: `"You received this because you were mentioned or are a participant in this Primer thread."`

HTML template lives inline in `resend.ts` as a `renderHtml()` function; no template engine for SP6 scope. Inline styles (Resend best practice for client compatibility). Plain-text fallback rendered from the same data, sent alongside.

### Resend API call

Single POST to `https://api.resend.com/emails` with `Authorization: Bearer <key>`. Body: `{ from, to, subject, html, text }`. Uses Node's `fetch()` — no SDK dependency.

### Failure handling

Any non-2xx response is logged with the recipient + error body and the loop moves to the next recipient. One bad recipient doesn't block the rest. The outer `void ...catch()` in the route handler catches any thrown errors so the HTTP response is unaffected.

### Tests

`apps/api/src/notifications/resend.test.ts`:

- Mock global `fetch` with Vitest.
- Assert the API call shape (URL, auth header, body keys).
- Assert per-recipient signal logic (mention only / reply only / both produce correct subject and body lead).
- Assert self-actor is excluded even if accidentally in `args.mentionedUserIds` or `args.participantUserIds`.
- Assert rendering: correct subject, correct CTA URL, correct signal copy, doc title truncation.

No live Resend traffic in tests.

---

## Section 6 — Deep-link hash handling on the SPA

Email link format: `https://primer-polygon.up.railway.app/d/:docId/v/:N#thread-:threadId`.

The route `/d/:docId/v/:N` already exists from SP4 (renders read-mostly on non-latest versions). What's new in SP6: the SPA must scroll the sidebar to the named thread on load and trigger the existing highlight pathway.

**One effect in `DocumentPage`:**

```tsx
useEffect(() => {
  const hash = window.location.hash;
  const match = hash.match(/^#thread-([a-f0-9-]+)$/i);
  if (!match) return;
  const threadId = match[1];

  // Wait until threads have loaded so the DOM node exists.
  if (!threadsQuery.isSuccess) return;

  const found = threads.find((t) => t.id === threadId);
  if (!found) return;

  document.getElementById(`thread-${threadId}`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });

  onHighlight(threadId);

  // Clear the hash so a manual refresh doesn't re-fire forever.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}, [threadsQuery.isSuccess, threads]);
```

**Three supporting changes:**

- `ThreadCard` adds `id={\`thread-${thread.id}\`}` to its outermost `<article>`.
- `CommentSidebar`'s `collapsed` state is currently owned internally and persisted to `localStorage` under `primer.sidebar.collapsed`. Lift state up: `CommentSidebar` accepts optional `collapsed?: boolean` + `onCollapsedChange?: (next: boolean) => void` props. When provided, the sidebar runs in controlled mode and skips the internal `useState`. Backwards-compatible — uncontrolled callers keep working. The localStorage write moves into `onCollapsedChange`'s default handler so persistence behaviour is unchanged.
- `DocumentPage` owns the sidebar's collapsed state (initialized from `localStorage`) and passes it through. The hash effect calls `setCollapsed(false)` before scrolling when a thread is found.

**Edge cases:**

- **Thread not on this version** (hand-edited URL, deleted thread): the `find()` returns nothing, effect quietly no-ops. User sees the doc at v:N with no highlight.
- **Version doesn't exist:** the existing "Version not found" screen (SP4) shows; the hash effect bails because `threadsQuery` is never successful.

---

## Section 7 — Out of scope

- **Slack notifier.** Whole reason we went email-first. The `Notifier` interface is the seam; a `SlackNotifier` lands in a future task if email-only doesn't deliver enough engagement.
- **Okta directory typeahead.** Typeahead restricted to the `users` table (signed-in users). Adding the Okta directory lookup is a future small task requiring the `okta.users.read` scope from IT.
- **Per-user notification preferences UI** (mute, daily digest, opt-out). v1 always sends. Footer line is the only "controls" hint.
- **Unsubscribe link.** Internal mention notifications to work addresses don't trigger CAN-SPAM-style requirements. If anyone asks, a one-line `notifications_disabled` flag + a one-click endpoint follows.
- **Email send log / "sent" history table.** Fire-and-forget; failures hit the API logs only. No admin "did X get notified?" view in SP6.
- **Retry on transient Resend failure.** A 5xx from Resend is logged and dropped. If we ever see this in practice, the jobs-table pattern from the PRD becomes the upgrade.
- **Per-recipient throttling / rate limiting.** PRD: "no rate limiting in v1; revisit if a chatty thread produces real complaints." Holds.
- **Mention IDs surviving display-name changes.** Q2 decision accepts this trade. Display names from Okta don't change in practice.
- **Live in-app notifications** (bell icon, real-time toast). Email is the only channel in v1.
- **Cross-version thread migration.** Threads stay on the version where they were authored; the email link version-pins to that version. Settled in SP4.
- **Token-aware editor / mention chips that delete as a unit.** `MentionTextarea` is a plain textarea with a typeahead popover; backspacing through `@Alice Tester` deletes character by character. Submit-time reconciliation handles the "deleted by re-typing" case.

---

## Decision log (Q1–Q7)

For traceability — the seven forks decided during brainstorming.

| # | Topic | Decision |
|---|---|---|
| 1 | Notifier backend | Email via Resend. `Notifier` interface allows Slack later via a swappable impl. |
| 2 | Mention syntax + storage | Plain-text body with `@First Last`; `mentions: text[]` column tracks authoritative user IDs (already in schema). |
| 3 | Typeahead source | Only users present in the `users` table (have signed in to Primer). Okta directory deferred. |
| 4 | Resend sending domain | `primer@sequence-demos.xyz` — user-controlled, already verified in Resend. |
| 5 | Dispatch model | Fire-and-forget after HTTP response. No jobs table, no retry. |
| 6 | Dedup | One email per recipient per comment, signals merged. Two interface methods collapse into one `notifyComment`. |
| 7 | Deep links | Version-pinned `/d/:docId/v/:N#thread-:threadId`. SPA hash-scroll-and-highlight on load. |
