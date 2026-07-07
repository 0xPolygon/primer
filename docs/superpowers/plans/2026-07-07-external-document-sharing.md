# External Document Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share individual documents with external clients via an email allowlist gated by a 6-digit OTP, serving an explicitly published version full-screen with expiry, revocation, view audit, and first-view notifications.

**Architecture:** A fully separate "external viewer" identity plane inside the existing apps: five new Postgres tables, a module family under `apps/api/src/external/`, unauthenticated `/api/share/:shareToken/*` routes, internal `canManage`-gated admin routes, and a branded `/share/:shareToken` React page outside the AppShell. External viewers never touch `users`, Okta, `primer_sid`, or MCP.

**Tech Stack:** Hono 4 + Drizzle/Postgres 17 + vitest (API), React 19 + React Router 7 + TanStack Query + Tailwind v4 (web), Mailgun via the existing `Notifier` interface. **Zero new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-07-external-document-sharing-design.md`

## Global Constraints

- Package manager is **pnpm** only. **No new npm dependencies anywhere in this plan** (supply-chain policy: `minimumReleaseAge` 14d, `allowBuilds {}`). All crypto uses `node:crypto`.
- ESM TypeScript with explicit `.ts` import specifiers (existing codebase convention).
- IDs: `import { v7 as uuidv7 } from 'uuid'` for UUID PKs (existing pattern); session IDs are `randomBytes(32).toString('hex')`.
- API tests run against `primer_test` DB, serialized (`fileParallelism: false`), truncated between tests by `apps/api/src/testing/setup.ts`. Run: `pnpm --filter @primer/api test`.
- Migrations: `pnpm --filter @primer/api db:generate` then `pnpm --filter @primer/api db:migrate` (dev DB) and `pnpm --filter @primer/api db:migrate:test` (test DB; requires `DATABASE_URL_TEST`).
- External viewer cookie name: `primer_ext_sid` (HttpOnly, Secure on HTTPS, SameSite=Lax, Path=/).
- OTP: exactly 6 digits, 10-minute TTL, max **5** attempts charged atomically in Postgres, single-use, SHA-256 hash + `timingSafeEqual`.
- Share token: `randomBytes(32).toString('base64url')` (256 bits).
- Viewer session TTL: 30 days, **no** sliding refresh.
- Recipient expiry default: 90 days.
- Enumeration safety: `request-code` always returns the identical `{ "ok": true }` body for allowlisted and unknown emails; `verify` returns the identical `{ "error": "invalid_code" }` for unknown email vs. wrong code. Email sending is fire-and-forget so latency doesn't differ.
- Every `/api/share/*` response sets `x-robots-tag: noindex`.
- **Never `git push` without explicit user instruction in the turn** (standing project rule).
- Do NOT weaken `ARTIFACT_CSP`, the iframe sandbox, `PUBLIC_PATHS` beyond the two documented prefixes, or the CSRF middleware. Any deviation from this plan that touches auth/CSP/CORS/sanitization requires explicit user approval first.

**Plan-level design refinement vs. spec** (spec is amended in Task 12): external content is delivered as a **top-level document** (`GET /api/share/:shareToken/content`), exactly like the existing internal full-screen mode (`document.tsx:278-285` does `window.open('/api/versions/:id/content')`). The spec's "sandboxed-iframe" wording doesn't survive contact with the codebase: sandboxed iframes make cross-site subresource requests, which strips SameSite=Lax cookies (documented at `apps/api/src/middleware/auth.ts:22-29`), so the viewer cookie would never arrive. Top-level navigation sends Lax cookies, matches the user's "exactly like our current full-screen mode" requirement, and keeps the identical `ARTIFACT_CSP` protections (`connect-src 'none'`, `form-action 'none'`) that the internal full-screen path already relies on.

**Issue-board mapping** (CLAUDE.md sizing): Tasks 1–5 = sub-issue "external sharing: data + core modules"; Tasks 6 = "public OTP/content API"; Task 7–8 = "internal management API"; Tasks 9–10 = "frontend"; Tasks 11–12 = "hardening tests + docs".

---

### Task 1: Schema, migration, test-setup truncation

**Files:**
- Modify: `packages/shared/src/schema.ts` (append after `documentFolders`, ~line 307)
- Modify: `apps/api/src/testing/setup.ts:6`
- Create (generated): `apps/api/drizzle/0010_<name>.sql` via drizzle-kit

**Interfaces:**
- Produces: Drizzle tables `externalShares`, `externalRecipients`, `externalOtps`, `externalViewerSessions`, `externalViews` exported from `@primer/shared/schema` — column names exactly as below; all later tasks import these.

- [ ] **Step 1: Append the five tables to `packages/shared/src/schema.ts`**

```ts
// ---------------------------------------------------------------------------
// External sharing plane. External viewers are NOT users: no rows in `users`,
// no Okta, no primer_sid sessions. Everything below joins back to documents
// so revocation/soft-delete kill access at request time.
// ---------------------------------------------------------------------------

export const externalShares = pgTable(
  'external_shares',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // High-entropy URL token (base64url of 32 random bytes) — deliberately
    // not the document UUID, so share URLs are non-enumerable and revocable
    // independently of the doc.
    shareToken: text('share_token').notNull(),
    // Nullable: nothing is externally visible until the first explicit publish.
    publishedVersionId: uuid('published_version_id').references(() => versions.id),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byToken: uniqueIndex('external_shares_token_unique').on(t.shareToken),
    oneActivePerDoc: uniqueIndex('external_shares_doc_active_unique')
      .on(t.documentId)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);

export const externalRecipients = pgTable(
  'external_recipients',
  {
    id: uuid('id').primaryKey(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => externalShares.id, { onDelete: 'cascade' }),
    email: text('email').notNull(), // stored lowercased
    addedBy: text('added_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
  },
  (t) => ({
    uniqShareEmail: uniqueIndex('external_recipients_share_email_unique').on(t.shareId, t.email),
  }),
);

export const externalOtps = pgTable(
  'external_otps',
  {
    id: uuid('id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // sha-256 hex of the 6-digit code
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    byRecipient: index('external_otps_recipient_idx').on(t.recipientId),
  }),
);

export const externalViewerSessions = pgTable(
  'external_viewer_sessions',
  {
    id: text('id').primaryKey(), // randomBytes(32).toString('hex')
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byRecipient: index('external_viewer_sessions_recipient_idx').on(t.recipientId),
    byExpiry: index('external_viewer_sessions_expires_at_idx').on(t.expiresAt),
  }),
);

export const externalViews = pgTable(
  'external_views',
  {
    id: uuid('id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byRecipient: index('external_views_recipient_idx').on(t.recipientId),
  }),
);
```

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
pnpm --filter @primer/api db:generate
pnpm --filter @primer/api db:migrate
pnpm --filter @primer/api db:migrate:test
```
Expected: a new `apps/api/drizzle/0010_*.sql` containing the five `CREATE TABLE`s; both migrate commands print `Migrations applied.`

- [ ] **Step 3: Add the tables to the test truncation list**

In `apps/api/src/testing/setup.ts`, replace the first truncate statement with:

```ts
  await sql`truncate table external_views, external_viewer_sessions, external_otps, external_recipients, external_shares, document_collaborators, document_views, comments, threads, versions, documents, document_folders, folders restart identity cascade`;
```

- [ ] **Step 4: Verify nothing regressed**

Run: `pnpm --filter @primer/api test`
Expected: full suite PASS (no new tests yet; proves migration + truncation don't break anything).

Run: `pnpm typecheck`
Expected: PASS across workspace.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schema.ts apps/api/drizzle apps/api/src/testing/setup.ts
git commit -m "feat(shared): add external sharing schema (shares, recipients, otps, viewer sessions, views)"
```

---

### Task 2: Token/OTP primitives — `apps/api/src/external/tokens.ts`

**Files:**
- Create: `apps/api/src/external/tokens.ts`
- Test: `apps/api/src/external/tokens.test.ts`

**Interfaces:**
- Produces: `generateShareToken(): string`, `generateOtpCode(): string`, `hashOtpCode(code: string): string`, `otpHashesEqual(aHex: string, bHex: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/external/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { generateShareToken, generateOtpCode, hashOtpCode, otpHashesEqual } from './tokens.ts';

describe('external tokens', () => {
  it('share tokens are 43-char base64url and unique', () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
    expect(a).not.toBe(b);
  });

  it('OTP codes are always exactly 6 digits', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('hashOtpCode is a stable sha-256 hex', () => {
    expect(hashOtpCode('123456')).toBe(hashOtpCode('123456'));
    expect(hashOtpCode('123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('123457'));
  });

  it('otpHashesEqual compares correctly and rejects length mismatch', () => {
    const h = hashOtpCode('654321');
    expect(otpHashesEqual(h, hashOtpCode('654321'))).toBe(true);
    expect(otpHashesEqual(h, hashOtpCode('000000'))).toBe(false);
    expect(otpHashesEqual(h, 'abcd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @primer/api test -- src/external/tokens.test.ts`
Expected: FAIL — cannot find module `./tokens.ts`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/external/tokens.ts
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

/** 256-bit URL token for /share/:shareToken. Not the doc UUID by design. */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 6-digit OTP. `crypto.randomInt` is cryptographically secure and unbiased
 * (rejection sampling internally), so no manual modulo handling is needed.
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time comparison of two sha-256 hex digests. */
export function otpHashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @primer/api test -- src/external/tokens.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/external
git commit -m "feat(api): external share token and OTP primitives"
```

---

### Task 3: OTP lifecycle — `apps/api/src/external/otp.ts`

**Files:**
- Create: `apps/api/src/external/otp.ts`
- Test: `apps/api/src/external/otp.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, Task 2 primitives.
- Produces: `OTP_TTL_MS`, `OTP_MAX_ATTEMPTS = 5`, `issueOtp(recipientId: string): Promise<{ code: string }>`, `verifyOtp(recipientId: string, code: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/external/otp.test.ts
import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, versions, externalShares, externalRecipients, externalOtps } from '@primer/shared/schema';
import { issueOtp, verifyOtp, OTP_MAX_ATTEMPTS } from './otp.ts';
import { generateShareToken } from './tokens.ts';

/** Insert the doc → share → recipient chain and return the recipient id. */
async function createRecipient(): Promise<string> {
  const docId = uuidv7();
  await db.insert(documents).values({ id: docId, title: 'Deck', uploaderId: 'mock-user-1' });
  const shareId = uuidv7();
  await db.insert(externalShares).values({
    id: shareId, documentId: docId, shareToken: generateShareToken(), createdBy: 'mock-user-1',
  });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return recipientId;
}

describe('OTP lifecycle', () => {
  it('verifies a correct code once, then rejects reuse', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    expect(await verifyOtp(r, code)).toBe(true);
    expect(await verifyOtp(r, code)).toBe(false); // consumed
  });

  it('rejects a wrong code and still accepts the right one within attempts', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    expect(await verifyOtp(r, '000000')).toBe(false);
    expect(await verifyOtp(r, code)).toBe(true);
  });

  it('kills the code after OTP_MAX_ATTEMPTS wrong guesses', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOtp(r, '999999')).toBe(false);
    }
    expect(await verifyOtp(r, code)).toBe(false); // attempts exhausted
  });

  it('rejects an expired code', async () => {
    const r = await createRecipient();
    const { code } = await issueOtp(r);
    await db.update(externalOtps)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(externalOtps.recipientId, r));
    expect(await verifyOtp(r, code)).toBe(false);
  });

  it('re-issuing invalidates the prior outstanding code', async () => {
    const r = await createRecipient();
    const first = await issueOtp(r);
    const second = await issueOtp(r);
    expect(await verifyOtp(r, first.code)).toBe(false);
    expect(await verifyOtp(r, second.code)).toBe(true);
    const live = await db.select().from(externalOtps)
      .where(and(eq(externalOtps.recipientId, r), isNull(externalOtps.consumedAt)));
    expect(live.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @primer/api test -- src/external/otp.test.ts`
Expected: FAIL — cannot find module `./otp.ts`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/external/otp.ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { externalOtps } from '@primer/shared/schema';
import { generateOtpCode, hashOtpCode, otpHashesEqual } from './tokens.ts';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** One live code per recipient: issuing consumes any outstanding code. */
export async function issueOtp(recipientId: string): Promise<{ code: string }> {
  const code = generateOtpCode();
  await db
    .update(externalOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(externalOtps.recipientId, recipientId), isNull(externalOtps.consumedAt)));
  await db.insert(externalOtps).values({
    id: uuidv7(),
    recipientId,
    codeHash: hashOtpCode(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return { code };
}

/**
 * Charge an attempt atomically BEFORE comparing, so concurrent guesses can
 * never exceed OTP_MAX_ATTEMPTS — the UPDATE's attempt_count guard is the
 * source of truth, not application logic.
 */
export async function verifyOtp(recipientId: string, code: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE external_otps
    SET attempt_count = attempt_count + 1
    WHERE recipient_id = ${recipientId}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND attempt_count < ${OTP_MAX_ATTEMPTS}
    RETURNING id, code_hash AS "codeHash"
  `)) as unknown as Array<{ id: string; codeHash: string }>;
  const otp = rows[0];
  if (!otp) return false;
  if (!otpHashesEqual(otp.codeHash, hashOtpCode(code))) return false;
  await db.update(externalOtps).set({ consumedAt: new Date() }).where(eq(externalOtps.id, otp.id));
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @primer/api test -- src/external/otp.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/external
git commit -m "feat(api): OTP issue/verify with atomic attempt charging"
```

---

### Task 4: Viewer sessions — `apps/api/src/external/session.ts`

**Files:**
- Create: `apps/api/src/external/session.ts`
- Test: `apps/api/src/external/session.test.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:
  - `VIEWER_COOKIE_NAME = 'primer_ext_sid'`, `VIEWER_SESSION_TTL_MS`
  - `createViewerSession(recipientId: string, userAgent: string | null): Promise<{ id: string; expiresAt: Date }>`
  - `lookupViewerSession(id: string, shareToken: string): Promise<ViewerContext | null>` where `ViewerContext = { sessionId: string; recipient: { id: string; email: string; firstViewedAt: Date | null; addedBy: string }; share: { id: string; documentId: string; publishedVersionId: string | null }; document: { id: string; title: string } }`
  - `deleteSessionsForRecipient(recipientId: string): Promise<void>`, `deleteSessionsForShare(shareId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/external/session.test.ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import {
  documents, externalShares, externalRecipients, externalViewerSessions,
} from '@primer/shared/schema';
import { generateShareToken } from './tokens.ts';
import {
  createViewerSession, lookupViewerSession,
  deleteSessionsForRecipient, deleteSessionsForShare,
} from './session.ts';

interface Chain { docId: string; shareId: string; shareToken: string; recipientId: string }

async function createChain(): Promise<Chain> {
  const docId = uuidv7();
  await db.insert(documents).values({ id: docId, title: 'Deck', uploaderId: 'mock-user-1' });
  const shareId = uuidv7();
  const shareToken = generateShareToken();
  await db.insert(externalShares).values({ id: shareId, documentId: docId, shareToken, createdBy: 'mock-user-1' });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return { docId, shareId, shareToken, recipientId };
}

describe('external viewer sessions', () => {
  it('creates and looks up a session through the full join chain', async () => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, 'vitest');
    const ctx = await lookupViewerSession(s.id, ch.shareToken);
    expect(ctx).not.toBeNull();
    expect(ctx!.recipient.email).toBe('client@example.com');
    expect(ctx!.share.documentId).toBe(ch.docId);
    expect(ctx!.share.publishedVersionId).toBeNull();
    expect(ctx!.document.title).toBe('Deck');
  });

  it('rejects a session presented against a different share token', async () => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, null);
    expect(await lookupViewerSession(s.id, generateShareToken())).toBeNull();
  });

  it.each([
    ['expired session', async (ch: Chain, sid: string) =>
      db.update(externalViewerSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(externalViewerSessions.id, sid))],
    ['revoked recipient', async (ch: Chain) =>
      db.update(externalRecipients).set({ revokedAt: new Date() }).where(eq(externalRecipients.id, ch.recipientId))],
    ['expired recipient', async (ch: Chain) =>
      db.update(externalRecipients).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(externalRecipients.id, ch.recipientId))],
    ['revoked share', async (ch: Chain) =>
      db.update(externalShares).set({ revokedAt: new Date() }).where(eq(externalShares.id, ch.shareId))],
    ['soft-deleted document', async (ch: Chain) =>
      db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, ch.docId))],
  ])('lookup dies on %s', async (_label, kill) => {
    const ch = await createChain();
    const s = await createViewerSession(ch.recipientId, null);
    await kill(ch, s.id);
    expect(await lookupViewerSession(s.id, ch.shareToken)).toBeNull();
  });

  it('deleteSessionsForRecipient / ForShare remove sessions', async () => {
    const ch = await createChain();
    const s1 = await createViewerSession(ch.recipientId, null);
    await deleteSessionsForRecipient(ch.recipientId);
    expect(await lookupViewerSession(s1.id, ch.shareToken)).toBeNull();
    const s2 = await createViewerSession(ch.recipientId, null);
    await deleteSessionsForShare(ch.shareId);
    expect(await lookupViewerSession(s2.id, ch.shareToken)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @primer/api test -- src/external/session.test.ts`
Expected: FAIL — cannot find module `./session.ts`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/external/session.ts
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { externalViewerSessions } from '@primer/shared/schema';

export const VIEWER_COOKIE_NAME = 'primer_ext_sid';
export const VIEWER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, no sliding refresh

export interface ViewerContext {
  sessionId: string;
  recipient: { id: string; email: string; firstViewedAt: Date | null; addedBy: string };
  share: { id: string; documentId: string; publishedVersionId: string | null };
  document: { id: string; title: string };
}

export async function createViewerSession(
  recipientId: string,
  userAgent: string | null,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VIEWER_SESSION_TTL_MS);
  await db.insert(externalViewerSessions).values({ id, recipientId, expiresAt, userAgent });
  return { id, expiresAt };
}

/**
 * Validate the entire chain in one query: session unexpired, recipient not
 * revoked/expired, share matches the token in the URL and is not revoked,
 * document not soft-deleted. Any broken link → null → viewer bounced to the
 * OTP screen. This is what makes revocation immediate.
 */
export async function lookupViewerSession(
  id: string,
  shareToken: string,
): Promise<ViewerContext | null> {
  const [row] = (await db.execute(sql`
    SELECT s.id                    AS "sessionId",
           r.id                    AS "recipientId",
           r.email                 AS "email",
           r.first_viewed_at       AS "firstViewedAt",
           r.added_by              AS "addedBy",
           sh.id                   AS "shareId",
           sh.document_id          AS "documentId",
           sh.published_version_id AS "publishedVersionId",
           d.title                 AS "title"
    FROM external_viewer_sessions s
    INNER JOIN external_recipients r ON r.id = s.recipient_id
    INNER JOIN external_shares sh    ON sh.id = r.share_id
    INNER JOIN documents d           ON d.id = sh.document_id
    WHERE s.id = ${id}
      AND s.expires_at > now()
      AND r.revoked_at IS NULL
      AND r.expires_at > now()
      AND sh.share_token = ${shareToken}
      AND sh.revoked_at IS NULL
      AND d.deleted_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{
    sessionId: string;
    recipientId: string;
    email: string;
    firstViewedAt: Date | string | null;
    addedBy: string;
    shareId: string;
    documentId: string;
    publishedVersionId: string | null;
    title: string;
  }>;
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    recipient: {
      id: row.recipientId,
      email: row.email,
      firstViewedAt:
        row.firstViewedAt === null
          ? null
          : row.firstViewedAt instanceof Date
            ? row.firstViewedAt
            : new Date(row.firstViewedAt),
      addedBy: row.addedBy,
    },
    share: { id: row.shareId, documentId: row.documentId, publishedVersionId: row.publishedVersionId },
    document: { id: row.documentId, title: row.title },
  };
}

export async function deleteSessionsForRecipient(recipientId: string): Promise<void> {
  await db.execute(sql`DELETE FROM external_viewer_sessions WHERE recipient_id = ${recipientId}`);
}

export async function deleteSessionsForShare(shareId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM external_viewer_sessions
    WHERE recipient_id IN (SELECT id FROM external_recipients WHERE share_id = ${shareId})
  `);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @primer/api test -- src/external/session.test.ts`
Expected: all tests PASS (the `it.each` expands to 5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/external
git commit -m "feat(api): external viewer sessions with full-chain validation"
```

---

### Task 5: Notifier extension (OTP email + first-view email)

**Files:**
- Modify: `apps/api/src/notifications/notifier.ts`
- Modify: `apps/api/src/notifications/mailgun.ts`
- Test: `apps/api/src/notifications/mailgun.test.ts` (append)

**Interfaces:**
- Produces (added to `Notifier`):
  - `readonly emailEnabled: boolean`
  - `notifyExternalOtp(args: { toEmail: string; code: string }): Promise<void>`
  - `notifyExternalFirstView(args: { sharerUserId: string; viewerEmail: string; docId: string; docTitle: string }): Promise<void>`
- Consumed by Task 6 routes via `deps.notifier`.

- [ ] **Step 1: Extend the interface and NoopNotifier**

In `apps/api/src/notifications/notifier.ts`, add above the `Notifier` interface:

```ts
export interface NotifyExternalOtpArgs {
  toEmail: string;
  code: string;
}

export interface NotifyExternalFirstViewArgs {
  sharerUserId: string;
  viewerEmail: string;
  docId: string;
  docTitle: string;
}
```

Extend the interface:

```ts
export interface Notifier {
  /**
   * Whether OTP emails can actually reach recipients. The external-share
   * request-code route returns 503 when false, instead of pretending to send.
   */
  readonly emailEnabled: boolean;
  notifyComment(args: NotifyCommentArgs): Promise<void>;
  notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void>;
  notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void>;
  notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void>;
}
```

Extend `NoopNotifier`:

```ts
export class NoopNotifier implements Notifier {
  // Dev/test keep the OTP flow usable without Mailgun: codes are logged.
  // In production a Noop notifier means external sharing is unusable → 503.
  readonly emailEnabled = process.env.NODE_ENV !== 'production';

  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
    if (args.addedUserId === args.addedByUserId) return;
    logger.debug({ args }, 'notifyCollaboratorAdded (no-op)');
  }
  async notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void> {
    logger.info({ toEmail: args.toEmail, code: args.code }, 'external OTP code (no-op notifier, dev only)');
  }
  async notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void> {
    logger.debug({ args }, 'notifyExternalFirstView (no-op)');
  }
}
```

- [ ] **Step 2: Write failing Mailgun tests**

Append to `apps/api/src/notifications/mailgun.test.ts` (match the existing fetch-stubbing style in that file; if it stubs `globalThis.fetch` differently, follow its local pattern):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import { MailgunNotifier } from './mailgun.ts';

const cfg = {
  apiKey: 'k', domain: 'mg.example.com',
  fromAddress: 'primer@mg.example.com', appBaseUrl: 'https://primer.example.com',
};

describe('MailgunNotifier external emails', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emailEnabled is true', () => {
    expect(new MailgunNotifier(cfg).emailEnabled).toBe(true);
  });

  it('notifyExternalOtp sends the code in the body, not the subject, with no links', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await new MailgunNotifier(cfg).notifyExternalOtp({ toEmail: 'client@example.com', code: '123456' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.get('to')).toBe('client@example.com');
    expect(body.get('subject')).not.toContain('123456');
    expect(body.get('text')).toContain('123456');
    expect(body.get('text')).not.toContain('http');   // no clickable auth links
    expect(body.get('text')).not.toContain('Deck');   // never the doc title pre-verification
  });

  it('notifyExternalFirstView emails the sharer with viewer email and doc link', async () => {
    await db.insert(users).values({
      id: 'sharer-1', email: 'sharer@polygon.technology', displayName: 'Sharer',
    }).onConflictDoNothing();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await new MailgunNotifier(cfg).notifyExternalFirstView({
      sharerUserId: 'sharer-1', viewerEmail: 'client@example.com',
      docId: '0198c5a0-0000-7000-8000-000000000000', docTitle: 'Q3 Deck',
    });
    const body = new URLSearchParams(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.get('to')).toBe('sharer@polygon.technology');
    expect(body.get('subject')).toContain('client@example.com');
    expect(body.get('text')).toContain('/d/0198c5a0-0000-7000-8000-000000000000');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @primer/api test -- src/notifications/mailgun.test.ts`
Expected: FAIL — `notifyExternalOtp` not a function / `emailEnabled` missing. (Also: typecheck now fails until MailgunNotifier implements the new members — that's the point.)

- [ ] **Step 4: Implement in `mailgun.ts`**

First extract the duplicated send logic (it appears twice already) into a private method, then implement the two emails:

```ts
  readonly emailEnabled = true;

  private async send(to: string, subject: string, text: string, html: string): Promise<void> {
    const apiBase = (this.cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
    const endpoint = `${apiBase}/v3/${encodeURIComponent(this.cfg.domain)}/messages`;
    const authHeader = `Basic ${Buffer.from(`api:${this.cfg.apiKey}`).toString('base64')}`;
    const form = new URLSearchParams();
    form.set('from', this.cfg.fromAddress);
    form.set('to', to);
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
        logger.error({ status: res.status, to, errBody: errBody.slice(0, 300) }, 'mailgun send failed');
      }
    } catch (err) {
      logger.error({ err, to }, 'mailgun fetch threw');
    }
  }

  async notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void> {
    // Deliberately: no doc title (recipient is unverified), no links (the
    // recipient is already on the page; links in OTP mail train bad habits
    // and get eaten by corporate link-scanners).
    const subject = 'Your Primer verification code';
    const text = [
      'Someone requested a verification code for a document shared with you on Primer.',
      '',
      `Your code: ${args.code}`,
      '',
      'The code expires in 10 minutes. If you did not request it, ignore this email.',
    ].join('\n');
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">Someone requested a verification code for a document shared with you on Primer.</p>
    <p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;color:#171717;">${escapeHtml(args.code)}</p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">The code expires in 10 minutes. If you did not request it, ignore this email.</p>
  </td></tr>
</table>
</body></html>`;
    await this.send(args.toEmail, subject, text, html);
  }

  async notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void> {
    const rows = (await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, [args.sharerUserId]))) as UserRow[];
    const sharer = rows[0];
    if (!sharer) {
      logger.warn({ sharerUserId: args.sharerUserId }, 'first-view: sharer not found, skipping');
      return;
    }
    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.docId}`;
    const subject = `${args.viewerEmail} viewed '${truncate(args.docTitle, SUBJECT_TITLE_LIMIT)}'`;
    const text = [
      `${args.viewerEmail} opened '${args.docTitle}' for the first time.`,
      '',
      `Open the doc: ${url}`,
      '',
      'You received this because you shared this document externally.',
    ].join('\n');
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;"><strong>${escapeHtml(args.viewerEmail)}</strong> opened '<strong style="color:#171717;">${escapeHtml(args.docTitle)}</strong>' for the first time.</p>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open the doc</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you shared this document externally.</p>
  </td></tr>
</table>
</body></html>`;
    await this.send(sharer.email, subject, text, html);
  }
```

Also refactor `notifyComment` / `notifyCollaboratorAdded` to call `this.send(...)` instead of their inline fetch blocks, and add the two new imports (`NotifyExternalOtpArgs`, `NotifyExternalFirstViewArgs`) to the import from `./notifier.ts`.

- [ ] **Step 5: Run the full notifications suite + typecheck**

Run: `pnpm --filter @primer/api test -- src/notifications && pnpm --filter @primer/api typecheck`
Expected: PASS (existing comment/collab tests still green after the `send()` refactor).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/notifications
git commit -m "feat(api): OTP and first-view notification emails"
```

---

### Task 6: Public share routes + auth-middleware public prefixes

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/routes/externalShare.ts`
- Modify: `apps/api/src/app.ts` (import + register)
- Test: `apps/api/src/routes/externalShare.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 modules; `checkRateLimit` (`apps/api/src/lib/rateLimiter.ts`); `ARTIFACT_CSP` (`./versionContent.ts`); `parseCookie`/`serializeCookie` (`../auth/cookies.ts`).
- Produces public endpoints:
  - `GET  /api/share/:shareToken/session` → `{ authenticated: false }` | `{ authenticated: true, documentTitle: string, published: boolean }`
  - `POST /api/share/:shareToken/request-code` `{ email }` → `{ ok: true }` (always) | 400 | 429 | 503
  - `POST /api/share/:shareToken/verify` `{ email, code }` → `{ ok: true }` + Set-Cookie | 400 `{ error: 'invalid_code' }` | 429
  - `GET  /api/share/:shareToken/content` → artifact HTML (top-level document) | 302 → `/share/:shareToken`

CSRF note: `/api/share/*` POSTs stay **inside** CSRF protection (they are not in `PUBLIC_PATHS`' exact-match Set used by `csrfMiddleware`); the frontend sends `X-Primer-Csrf: 1`. Do not exempt them.

- [ ] **Step 1: Make the share paths public in the auth middleware**

In `apps/api/src/middleware/auth.ts`, add below `isPublicWellKnown`:

```ts
// External share plane: the /share/:token SPA page and its /api/share/*
// endpoints authenticate viewers with their own OTP + primer_ext_sid cookie
// (see apps/api/src/external/), never the internal session. They must be
// reachable without an Okta session.
function isExternalSharePath(path: string): boolean {
  return path.startsWith('/share/') || path.startsWith('/api/share/');
}
```

and extend the skip line:

```ts
    if (PUBLIC_PATHS.has(path) || isPublicCompanionAsset(path) || isPublicWellKnown(path) || isExternalSharePath(path)) return next();
```

- [ ] **Step 2: Write the failing route tests**

```ts
// apps/api/src/routes/externalShare.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier, type NotifyExternalOtpArgs, type NotifyExternalFirstViewArgs } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import {
  versions as versionsTable, externalShares, externalRecipients, externalViews,
} from '@primer/shared/schema';
import { generateShareToken } from '../external/tokens.ts';
import { _resetRateLimiterForTests } from '../lib/rateLimiter.ts';
import { ARTIFACT_CSP } from './versionContent.ts';
import { CSRF_HEADERS } from '../test/harness.ts';

class CaptureNotifier extends NoopNotifier {
  override readonly emailEnabled = true;
  otps: NotifyExternalOtpArgs[] = [];
  firstViews: NotifyExternalFirstViewArgs[] = [];
  override async notifyExternalOtp(a: NotifyExternalOtpArgs): Promise<void> { this.otps.push(a); }
  override async notifyExternalFirstView(a: NotifyExternalFirstViewArgs): Promise<void> { this.firstViews.push(a); }
}

const JSON_HEADERS = { ...CSRF_HEADERS, 'content-type': 'application/json' };

interface Fixture {
  app: ReturnType<typeof createApp>;
  notifier: CaptureNotifier;
  root: string;
  docId: string;
  versionId: string;
  shareToken: string;
  recipientId: string;
}

/** Upload a doc as mock-user-1, then wire share + recipient + publish directly. */
async function fixture(opts: { publish?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'primer-ext-test-'));
  const notifier = new CaptureNotifier();
  const app = createApp({ storage: new FilesystemStorage(root), notifier });
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><h1>External Deck</h1></body></html>'], { type: 'text/html' }), 'd.html');
  fd.append('title', 'External Deck');
  const up = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  const { documentId, versionId } = (await up.json()) as { documentId: string; versionId: string };
  const shareToken = generateShareToken();
  const shareId = uuidv7();
  await db.insert(externalShares).values({
    id: shareId, documentId, shareToken, createdBy: 'mock-user-1',
    publishedVersionId: opts.publish === false ? null : versionId,
  });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return { app, notifier, root, docId: documentId, versionId, shareToken, recipientId };
}

async function requestCode(f: Fixture, email: string) {
  return f.app.request(`/api/share/${f.shareToken}/request-code`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email }),
  });
}

/** Full happy path up to an authenticated cookie. */
async function authenticate(f: Fixture): Promise<string> {
  await requestCode(f, 'client@example.com');
  const code = f.notifier.otps.at(-1)!.code;
  const res = await f.app.request(`/api/share/${f.shareToken}/verify`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ email: 'client@example.com', code }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  expect(setCookie).toContain('primer_ext_sid=');
  expect(setCookie).toContain('HttpOnly');
  return setCookie.split(';')[0]; // "primer_ext_sid=<id>"
}

describe('external share public routes', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('request-code returns byte-identical bodies for allowlisted and unknown emails', async () => {
    const f = await fixture();
    try {
      const known = await requestCode(f, 'client@example.com');
      const unknown = await requestCode(f, 'stranger@example.com');
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await known.text()).toBe(await unknown.text());
      expect(f.notifier.otps.length).toBe(1); // only the real recipient got a code
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('request-code returns 503 when the notifier cannot send email', async () => {
    const f = await fixture();
    try {
      const noEmail = new CaptureNotifier();
      Object.defineProperty(noEmail, 'emailEnabled', { value: false });
      const app2 = createApp({ storage: new FilesystemStorage(f.root), notifier: noEmail });
      const res = await app2.request(`/api/share/${f.shareToken}/request-code`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'client@example.com' }),
      });
      expect(res.status).toBe(503);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('request-code rate-limits repeated sends for the same email', async () => {
    const f = await fixture();
    try {
      expect((await requestCode(f, 'client@example.com')).status).toBe(200);
      expect((await requestCode(f, 'client@example.com')).status).toBe(200);
      expect((await requestCode(f, 'client@example.com')).status).toBe(429);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('verify returns the identical error for unknown email vs wrong code', async () => {
    const f = await fixture();
    try {
      await requestCode(f, 'client@example.com');
      const wrongCode = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code: '000000' }),
      });
      const unknownEmail = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'stranger@example.com', code: '123456' }),
      });
      expect(wrongCode.status).toBe(400);
      expect(unknownEmail.status).toBe(400);
      expect(await wrongCode.text()).toBe(await unknownEmail.text());
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('happy path: verify sets cookie; content serves published version with CSP + noindex; audit row + first-view fire once', async () => {
    const f = await fixture();
    try {
      const cookie = await authenticate(f);

      const content = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(content.status).toBe(200);
      expect(content.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
      expect(content.headers.get('x-robots-tag')).toBe('noindex');
      expect(content.headers.get('cache-control')).toBe('private, no-store');
      expect(await content.text()).toContain('<h1>External Deck</h1>');

      const views = await db.select().from(externalViews).where(eq(externalViews.recipientId, f.recipientId));
      expect(views.length).toBe(1);
      expect(views[0].versionId).toBe(f.versionId);
      expect(f.notifier.firstViews.length).toBe(1);
      expect(f.notifier.firstViews[0].viewerEmail).toBe('client@example.com');

      // Second view: another audit row, but no second first-view notification.
      await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect((await db.select().from(externalViews).where(eq(externalViews.recipientId, f.recipientId))).length).toBe(2);
      expect(f.notifier.firstViews.length).toBe(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('content without a session 302s to the branded landing page', async () => {
    const f = await fixture();
    try {
      const res = await f.app.request(`/api/share/${f.shareToken}/content`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/share/${f.shareToken}`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('content with a session but nothing published 302s back to the landing page', async () => {
    const f = await fixture({ publish: false });
    try {
      const cookie = await authenticate(f);
      const res = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(res.status).toBe(302);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('session endpoint: identical unauthenticated response for valid and invalid tokens; title only after auth', async () => {
    const f = await fixture();
    try {
      const invalid = await f.app.request(`/api/share/${generateShareToken()}/session`);
      const valid = await f.app.request(`/api/share/${f.shareToken}/session`);
      expect(await invalid.text()).toBe(await valid.text());

      const cookie = await authenticate(f);
      const authed = await f.app.request(`/api/share/${f.shareToken}/session`, { headers: { cookie } });
      expect(await authed.json()).toEqual({ authenticated: true, documentTitle: 'External Deck', published: true });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('revoking the share kills an existing session immediately', async () => {
    const f = await fixture();
    try {
      const cookie = await authenticate(f);
      await db.update(externalShares).set({ revokedAt: new Date() })
        .where(eq(externalShares.shareToken, f.shareToken));
      const res = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(res.status).toBe(302);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('share routes are reachable without internal auth (no Okta redirect)', async () => {
    const f = await fixture();
    try {
      // No x-mock-user-id header at all → would 401/302-to-login on internal routes.
      const res = await f.app.request(`/api/share/${f.shareToken}/session`);
      expect(res.status).toBe(200);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @primer/api test -- src/routes/externalShare.test.ts`
Expected: FAIL — module `./externalShare.ts` missing / 404s.

- [ ] **Step 4: Implement `apps/api/src/routes/externalShare.ts`**

```ts
import type { Hono, Context } from 'hono';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import { db } from '../db/client.ts';
import { externalViews } from '@primer/shared/schema';
import { checkRateLimit } from '../lib/rateLimiter.ts';
import { parseCookie, serializeCookie } from '../auth/cookies.ts';
import { issueOtp, verifyOtp } from '../external/otp.ts';
import {
  createViewerSession, lookupViewerSession,
  VIEWER_COOKIE_NAME, VIEWER_SESSION_TTL_MS,
} from '../external/session.ts';
import { ARTIFACT_CSP } from './versionContent.ts';
import { logger } from '../logger.ts';

const GENERIC_OK = { ok: true } as const;

function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

function viewerSessionId(c: Context): string | null {
  return parseCookie(c.req.header('cookie') ?? null, VIEWER_COOKIE_NAME);
}

/** Active recipient on an active share of a live doc, matched by email. */
async function findActiveRecipient(
  shareToken: string,
  email: string,
): Promise<{ recipientId: string } | null> {
  const [row] = (await db.execute(sql`
    SELECT r.id AS "recipientId"
    FROM external_recipients r
    INNER JOIN external_shares sh ON sh.id = r.share_id
    INNER JOIN documents d ON d.id = sh.document_id
    WHERE sh.share_token = ${shareToken}
      AND sh.revoked_at IS NULL
      AND d.deleted_at IS NULL
      AND r.email = ${email.trim().toLowerCase()}
      AND r.revoked_at IS NULL
      AND r.expires_at > now()
    LIMIT 1
  `)) as unknown as Array<{ recipientId: string }>;
  return row ?? null;
}

export function registerExternalShareRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  // Nothing under /api/share may be indexed.
  app.use('/api/share/*', async (c, next) => {
    await next();
    c.header('x-robots-tag', 'noindex');
  });

  app.get('/api/share/:shareToken/session', async (c) => {
    const sid = viewerSessionId(c);
    const ctx = sid ? await lookupViewerSession(sid, c.req.param('shareToken')) : null;
    // Identical response for invalid token and valid-but-unauthenticated:
    // no token-validity oracle, no title before verification.
    if (!ctx) return c.json({ authenticated: false });
    return c.json({
      authenticated: true,
      documentTitle: ctx.document.title,
      published: ctx.share.publishedVersionId !== null,
    });
  });

  app.post('/api/share/:shareToken/request-code', async (c) => {
    if (!deps.notifier.emailEnabled) {
      return c.json({ error: 'email_unavailable' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email || email.length > 320 || !email.includes('@')) {
      return c.json({ error: 'invalid_email' }, 400);
    }
    const shareToken = c.req.param('shareToken');
    // Send-abuse limits (fixed 60s windows). Applied before any DB lookup so
    // hitting them reveals nothing about allowlist membership.
    if (
      !checkRateLimit(`ext-otp-send:ip:${clientIp(c)}`, 10) ||
      !checkRateLimit(`ext-otp-send:email:${email.toLowerCase()}`, 2) ||
      !checkRateLimit(`ext-otp-send:share:${shareToken}`, 30)
    ) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const recipient = await findActiveRecipient(shareToken, email);
    if (recipient) {
      const { code } = await issueOtp(recipient.recipientId);
      // Fire-and-forget so response latency doesn't reveal whether we sent.
      void deps.notifier
        .notifyExternalOtp({ toEmail: email, code })
        .catch((err) => logger.error({ err }, 'external OTP send failed'));
    }
    // Same body whether or not the email was on the allowlist.
    return c.json(GENERIC_OK);
  });

  app.post('/api/share/:shareToken/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) return c.json({ error: 'invalid_code' }, 400);
    if (!checkRateLimit(`ext-otp-verify:ip:${clientIp(c)}`, 20)) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const recipient = await findActiveRecipient(c.req.param('shareToken'), email);
    // Unknown email and wrong code are indistinguishable by design.
    if (!recipient) return c.json({ error: 'invalid_code' }, 400);
    const ok = await verifyOtp(recipient.recipientId, code);
    if (!ok) return c.json({ error: 'invalid_code' }, 400);

    const session = await createViewerSession(
      recipient.recipientId,
      c.req.header('user-agent') ?? null,
    );
    const secure = new URL(c.req.url).protocol === 'https:';
    c.header(
      'set-cookie',
      serializeCookie(VIEWER_COOKIE_NAME, session.id, {
        maxAge: Math.floor(VIEWER_SESSION_TTL_MS / 1000),
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
      }),
    );
    return c.json(GENERIC_OK);
  });

  // Serves the published version as a TOP-LEVEL document — same delivery as
  // the internal full-screen mode (document.tsx openFullScreen). Top-level
  // navigation sends the SameSite=Lax viewer cookie; a sandboxed iframe
  // would not (see middleware/auth.ts:22-29). Identical ARTIFACT_CSP applies.
  app.get('/api/share/:shareToken/content', async (c) => {
    const shareToken = c.req.param('shareToken');
    const sid = viewerSessionId(c);
    const ctx = sid ? await lookupViewerSession(sid, shareToken) : null;
    if (!ctx || ctx.share.publishedVersionId === null) {
      // Not authenticated / expired / revoked / nothing published: back to
      // the branded landing page, which shows the right state.
      return c.redirect(`/share/${shareToken}`, 302);
    }

    // Keyed by the share row's own pointer — this endpoint cannot be steered
    // to any other version or document.
    const [version] = (await db.execute(sql`
      SELECT id, storage_key AS "storageKey"
      FROM versions
      WHERE id = ${ctx.share.publishedVersionId}
      LIMIT 1
    `)) as unknown as Array<{ id: string; storageKey: string }>;
    if (!version) return c.redirect(`/share/${shareToken}`, 302);

    await db.insert(externalViews).values({
      id: uuidv7(),
      recipientId: ctx.recipient.id,
      versionId: version.id,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    });
    if (ctx.recipient.firstViewedAt === null) {
      // RETURNING guards the race: only the request that flips the flag
      // sends the notification.
      const updated = (await db.execute(sql`
        UPDATE external_recipients
        SET first_viewed_at = now()
        WHERE id = ${ctx.recipient.id} AND first_viewed_at IS NULL
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      if (updated.length > 0) {
        void deps.notifier
          .notifyExternalFirstView({
            sharerUserId: ctx.recipient.addedBy,
            viewerEmail: ctx.recipient.email,
            docId: ctx.document.id,
            docTitle: ctx.document.title,
          })
          .catch((err) => logger.error({ err }, 'first-view notification failed'));
      }
    }

    const stream = await deps.storage.get(version.storageKey);
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex',
      },
    });
  });
}
```

Register in `apps/api/src/app.ts`: add `import { registerExternalShareRoutes } from './routes/externalShare.ts';` with the other route imports, and `registerExternalShareRoutes(app, deps);` after `registerVersionContentRoute(app, deps);`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @primer/api test -- src/routes/externalShare.test.ts`
Expected: all tests PASS. Then run the whole API suite (`pnpm --filter @primer/api test`) — existing auth-middleware tests must stay green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/routes/externalShare.ts apps/api/src/app.ts apps/api/src/routes/externalShare.test.ts
git commit -m "feat(api): public external share routes (OTP request/verify, session, content)"
```

---

### Task 7: Shared API types + internal management routes

**Files:**
- Modify: `packages/shared/src/api.ts` (append; follow the file's existing DTO conventions — dates as ISO strings)
- Create: `apps/api/src/routes/externalShareAdmin.ts`
- Modify: `apps/api/src/app.ts` (register after `registerCollaboratorRoutes`)
- Test: `apps/api/src/routes/externalShareAdmin.test.ts`

**Interfaces:**
- Consumes: `canManage`, `canRead`, `effectiveRole`, `loadCollaboratorRole` from `../lib/permissions.ts` (gate copied from `collaborators.ts:23-56` pattern); `generateShareToken` (Task 2); `deleteSessionsForRecipient` / `deleteSessionsForShare` (Task 4).
- Produces endpoints (all behind internal auth + `canManage`):
  - `GET    /api/documents/:docId/external-share` → `ExternalShareResponse`
  - `POST   /api/documents/:docId/external-share` → 201 created | 409 if active share exists
  - `DELETE /api/documents/:docId/external-share` → revoke share + kill sessions
  - `POST   /api/documents/:docId/external-share/recipients` `{ email, expiresInDays? }` → 201 | 409 duplicate
  - `DELETE /api/documents/:docId/external-share/recipients/:recipientId` → revoke recipient + kill sessions
  - `POST   /api/documents/:docId/external-share/publish` `{ versionId }` → set published pointer
- Produces shared types (consumed by frontend Task 9–10):

```ts
// append to packages/shared/src/api.ts
export interface ExternalRecipientDto {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ExternalShareDto {
  id: string;
  shareToken: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  createdAt: string;
}

export interface ExternalShareResponse {
  share: ExternalShareDto | null;
  recipients: ExternalRecipientDto[];
  /** False when the server has no working email transport (NoopNotifier in
   *  production) — the sharer UI must warn that external sharing is unusable. */
  emailEnabled: boolean;
}

export interface AddExternalRecipientRequest {
  email: string;
  expiresInDays?: number; // default 90, max 365
}

export interface PublishExternalShareRequest {
  versionId: string;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/routes/externalShareAdmin.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { ExternalShareResponse } from '@primer/shared';
import { CSRF_HEADERS, asUser, asUserJson } from '../test/harness.ts';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-extadmin-'));
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

async function uploadDoc(app: ReturnType<typeof createApp>) {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body>x</body></html>'], { type: 'text/html' }), 'd.html');
  fd.append('title', 'Deck');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as { documentId: string; versionId: string };
}

describe('external share admin routes', () => {
  it('owner can create, add recipient, publish, and read back the share', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await uploadDoc(app);

      const created = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      expect(created.status).toBe(201);

      const dup = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      expect(dup.status).toBe(409);

      const addRec = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'Client@Example.com' }),
      });
      expect(addRec.status).toBe(201);

      const pub = await app.request(`/api/documents/${documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId }),
      });
      expect(pub.status).toBe(200);

      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      const body = (await get.json()) as ExternalShareResponse;
      expect(body.share).not.toBeNull();
      expect(body.share!.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.share!.publishedVersionId).toBe(versionId);
      expect(body.share!.publishedVersionNumber).toBe(1);
      expect(body.recipients.length).toBe(1);
      expect(body.recipients[0].email).toBe('client@example.com'); // lowercased
      expect(body.recipients[0].viewCount).toBe(0);
    });
  });

  it('publish rejects a version belonging to another document', async () => {
    await withApp(async (app) => {
      const a = await uploadDoc(app);
      const b = await uploadDoc(app);
      await app.request(`/api/documents/${a.documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const res = await app.request(`/api/documents/${a.documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId: b.versionId }),
      });
      expect(res.status).toBe(400);
    });
  });

  it('a non-collaborator cannot see or manage the share', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-2'),
      });
      expect(get.status).toBe(403); // org doc: readable, not manageable
      const rev = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-2'),
      });
      expect(rev.status).toBe(403);
    });
  });

  it('revoking a recipient and the whole share works and 404s on re-add duplicates only when active', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const add = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'client@example.com' }),
      });
      const { recipient } = (await add.json()) as { recipient: { id: string } };

      const del = await app.request(
        `/api/documents/${documentId}/external-share/recipients/${recipient.id}`,
        { method: 'DELETE', headers: asUserJson('mock-user-1') },
      );
      expect(del.status).toBe(200);

      const revoke = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-1'),
      });
      expect(revoke.status).toBe(200);

      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      expect(((await get.json()) as ExternalShareResponse).share).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @primer/api test -- src/routes/externalShareAdmin.test.ts`
Expected: FAIL (404s — routes missing).

- [ ] **Step 3: Implement `apps/api/src/routes/externalShareAdmin.ts`**

```ts
import type { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type {
  AddExternalRecipientRequest, ExternalShareResponse, PublishExternalShareRequest,
} from '@primer/shared';
import { documents, versions, externalShares, externalRecipients } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import {
  canManage, canRead, effectiveRole, loadCollaboratorRole, type Visibility,
} from '../lib/permissions.ts';
import { generateShareToken } from '../external/tokens.ts';
import { deleteSessionsForRecipient, deleteSessionsForShare } from '../external/session.ts';

const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;

// Same manage-gate as collaborators.ts: non-readers get 404 (don't reveal the
// doc exists), readers without manage rights get 403.
async function loadDocForManage(
  docId: string,
  userId: string,
): Promise<{ status: 'not_found' } | { status: 'forbidden' } | { status: 'ok' }> {
  const [row] = await db
    .select({
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!row || row.deletedAt !== null) return { status: 'not_found' };
  const collabRole = await loadCollaboratorRole(docId, userId);
  const eff = effectiveRole(
    { uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
    userId,
    collabRole,
  );
  if (!canRead(row.visibility as Visibility, eff)) return { status: 'not_found' };
  if (!canManage(eff)) return { status: 'forbidden' };
  return { status: 'ok' };
}

async function activeShare(docId: string): Promise<{ id: string; shareToken: string; publishedVersionId: string | null; createdAt: Date } | null> {
  const [row] = await db
    .select({
      id: externalShares.id,
      shareToken: externalShares.shareToken,
      publishedVersionId: externalShares.publishedVersionId,
      createdAt: externalShares.createdAt,
    })
    .from(externalShares)
    .where(and(eq(externalShares.documentId, docId), isNull(externalShares.revokedAt)));
  return row ?? null;
}

export function registerExternalShareAdminRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.get('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const emailEnabled = deps.notifier.emailEnabled;
    const share = await activeShare(docId);
    if (!share) {
      return c.json({ share: null, recipients: [], emailEnabled } satisfies ExternalShareResponse);
    }

    let publishedVersionNumber: number | null = null;
    if (share.publishedVersionId !== null) {
      const [v] = await db
        .select({ versionNumber: versions.versionNumber })
        .from(versions)
        .where(eq(versions.id, share.publishedVersionId));
      publishedVersionNumber = v?.versionNumber ?? null;
    }

    const recipients = (await db.execute(sql`
      SELECT r.id, r.email,
             r.created_at      AS "createdAt",
             r.expires_at      AS "expiresAt",
             r.revoked_at      AS "revokedAt",
             r.first_viewed_at AS "firstViewedAt",
             count(v.id)::int  AS "viewCount",
             max(v.viewed_at)  AS "lastViewedAt"
      FROM external_recipients r
      LEFT JOIN external_views v ON v.recipient_id = r.id
      WHERE r.share_id = ${share.id}
      GROUP BY r.id
      ORDER BY r.created_at
    `)) as unknown as Array<{
      id: string; email: string; createdAt: Date | string; expiresAt: Date | string;
      revokedAt: Date | string | null; firstViewedAt: Date | string | null;
      viewCount: number; lastViewedAt: Date | string | null;
    }>;

    const iso = (d: Date | string | null): string | null =>
      d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

    const body: ExternalShareResponse = {
      emailEnabled,
      share: {
        id: share.id,
        shareToken: share.shareToken,
        publishedVersionId: share.publishedVersionId,
        publishedVersionNumber,
        createdAt: share.createdAt.toISOString(),
      },
      recipients: recipients.map((r) => ({
        id: r.id,
        email: r.email,
        createdAt: iso(r.createdAt)!,
        expiresAt: iso(r.expiresAt)!,
        revokedAt: iso(r.revokedAt),
        firstViewedAt: iso(r.firstViewedAt),
        viewCount: r.viewCount,
        lastViewedAt: iso(r.lastViewedAt),
      })),
    };
    return c.json(body);
  });

  app.post('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    if (await activeShare(docId)) return c.json({ error: 'share_exists' }, 409);

    const share = {
      id: uuidv7(),
      documentId: docId,
      shareToken: generateShareToken(),
      createdBy: user.id,
    };
    await db.insert(externalShares).values(share);
    logger.info({ docId, shareId: share.id, userId: user.id }, 'external share created');
    return c.json({ share: { id: share.id, shareToken: share.shareToken } }, 201);
  });

  app.delete('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    await db.update(externalShares).set({ revokedAt: new Date() }).where(eq(externalShares.id, share.id));
    await deleteSessionsForShare(share.id);
    logger.info({ docId, shareId: share.id }, 'external share revoked');
    return c.json({ ok: true });
  });

  app.post('/api/documents/:docId/external-share/recipients', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const body = (await c.req.json().catch(() => null)) as AddExternalRecipientRequest | null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 320 || !email.includes('@')) {
      return c.json({ error: 'invalid_email' }, 400);
    }
    const days = Math.min(
      typeof body?.expiresInDays === 'number' && body.expiresInDays > 0
        ? Math.floor(body.expiresInDays)
        : DEFAULT_EXPIRY_DAYS,
      MAX_EXPIRY_DAYS,
    );

    const [existing] = await db
      .select({ id: externalRecipients.id, revokedAt: externalRecipients.revokedAt })
      .from(externalRecipients)
      .where(and(eq(externalRecipients.shareId, share.id), eq(externalRecipients.email, email)));
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    if (existing && existing.revokedAt === null) return c.json({ error: 'recipient_exists' }, 409);
    if (existing) {
      // Re-adding a previously revoked email: un-revoke with a fresh expiry.
      await db.update(externalRecipients)
        .set({ revokedAt: null, expiresAt, addedBy: user.id })
        .where(eq(externalRecipients.id, existing.id));
      return c.json({ recipient: { id: existing.id, email, expiresAt: expiresAt.toISOString() } }, 201);
    }
    const id = uuidv7();
    await db.insert(externalRecipients).values({ id, shareId: share.id, email, addedBy: user.id, expiresAt });
    return c.json({ recipient: { id, email, expiresAt: expiresAt.toISOString() } }, 201);
  });

  app.delete('/api/documents/:docId/external-share/recipients/:recipientId', async (c) => {
    const docId = c.req.param('docId');
    const recipientId = c.req.param('recipientId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const result = await db.update(externalRecipients)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(externalRecipients.id, recipientId),
        eq(externalRecipients.shareId, share.id), // recipient must belong to THIS doc's share
        isNull(externalRecipients.revokedAt),
      ))
      .returning({ id: externalRecipients.id });
    if (result.length === 0) return c.json({ error: 'not_found' }, 404);
    await deleteSessionsForRecipient(recipientId);
    return c.json({ ok: true });
  });

  app.post('/api/documents/:docId/external-share/publish', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const body = (await c.req.json().catch(() => null)) as PublishExternalShareRequest | null;
    const versionId = typeof body?.versionId === 'string' ? body.versionId : '';
    const [version] = await db
      .select({ id: versions.id })
      .from(versions)
      .where(and(eq(versions.id, versionId), eq(versions.documentId, docId)));
    if (!version) return c.json({ error: 'invalid_version' }, 400);

    await db.update(externalShares)
      .set({ publishedVersionId: version.id })
      .where(eq(externalShares.id, share.id));
    logger.info({ docId, shareId: share.id, versionId }, 'external share published');
    return c.json({ ok: true });
  });
}
```

Register in `app.ts`: import and call `registerExternalShareAdminRoutes(app, deps);` right after `registerCollaboratorRoutes(app, deps);`. Export the new types from `packages/shared/src/index.ts` if `api.ts` is re-exported there (follow how existing api types are exported).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @primer/api test -- src/routes/externalShareAdmin.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src apps/api/src/routes/externalShareAdmin.ts apps/api/src/routes/externalShareAdmin.test.ts apps/api/src/app.ts
git commit -m "feat(api): external share management routes for owners/editors"
```

---

### Task 8: `externallyShared` flag on the document API

**Files:**
- Modify: `apps/api/src/routes/documents.ts` (the `GET /api/documents/:docId` handler)
- Modify: the corresponding response type in `packages/shared/src/api.ts` (find the document-detail response interface used by `useDocument` and add the field)
- Test: `apps/api/src/routes/documents.test.ts` (append)

**Interfaces:**
- Produces: document-detail response gains `externallyShared: boolean` (true iff an active share exists). Visible to every internal reader so the badge can render; the share's token/recipients remain manage-only (Task 7).

- [ ] **Step 1: Write the failing test** (append to `documents.test.ts`, using its existing app-construction helpers)

```ts
it('reports externallyShared on the document payload', async () => {
  // Use this file's existing helper to create an app + upload a doc as mock-user-1,
  // matching the local pattern (see neighboring tests).
  const { documentId } = await uploadFixture(app);
  const before = await app.request(`/api/documents/${documentId}`, { headers: asUser('mock-user-1') });
  expect(((await before.json()) as { document: { externallyShared: boolean } }).document.externallyShared).toBe(false);

  await db.insert(externalShares).values({
    id: uuidv7(), documentId, shareToken: generateShareToken(), createdBy: 'mock-user-1',
  });
  const after = await app.request(`/api/documents/${documentId}`, { headers: asUser('mock-user-1') });
  expect(((await after.json()) as { document: { externallyShared: boolean } }).document.externallyShared).toBe(true);
});
```

(Adapt the fixture call to this test file's local helpers; add the `externalShares`/`generateShareToken`/`uuidv7` imports.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @primer/api test -- src/routes/documents.test.ts`
Expected: the new test FAILS (`externallyShared` undefined).

- [ ] **Step 3: Implement**

In the `GET /api/documents/:docId` handler in `documents.ts`, after the doc row is loaded and authorized, add:

```ts
    const [ext] = (await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM external_shares
        WHERE document_id = ${docId} AND revoked_at IS NULL
      ) AS "externallyShared"
    `)) as unknown as Array<{ externallyShared: boolean }>;
```

and include `externallyShared: ext?.externallyShared ?? false` in the `document` object of the JSON response. Add the field as `externallyShared: boolean` to the document DTO in `packages/shared/src/api.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @primer/api test -- src/routes/documents.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts packages/shared/src/api.ts
git commit -m "feat(api): expose externallyShared flag on document detail"
```

---

### Task 9: External viewer page — `/share/:shareToken`

**Files:**
- Create: `apps/web/src/routes/share.tsx`
- Modify: `apps/web/src/App.tsx` (top-level sibling route, NOT under `AppShell`)
- Create: `apps/web/src/lib/shareViewer.ts` + Test: `apps/web/src/lib/shareViewer.test.ts`

**Interfaces:**
- Consumes: `GET /api/share/:t/session`, `POST .../request-code`, `POST .../verify`, content URL `/api/share/:t/content` (Task 6).
- Produces: SPA route `/share/:shareToken`. Plain `fetch` with the CSRF header — NOT the `api()` wrapper from `lib/fetch.ts`, whose 401 handler redirects to Okta login (wrong for external visitors).

**Branding requirement:** before styling these screens, the implementer MUST invoke the `polygon-core:polygon-brand` skill and apply Polygon design tokens (colors, wordmark, typography) to the container, button, and input styles below. The structure and behavior here are final; the Tailwind color/spacing classes are the part the brand pass refines.

- [ ] **Step 1: Write the failing helper tests**

```ts
// apps/web/src/lib/shareViewer.test.ts
import { describe, it, expect } from 'vitest';
import { isPlausibleEmail, isCompleteCode, contentUrl } from './shareViewer.ts';

describe('shareViewer helpers', () => {
  it('validates plausible emails', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true);
    expect(isPlausibleEmail('')).toBe(false);
    expect(isPlausibleEmail('nope')).toBe(false);
    expect(isPlausibleEmail('x'.repeat(321) + '@b.co')).toBe(false);
  });
  it('accepts exactly 6 digits as a complete code', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
  it('builds the content URL', () => {
    expect(contentUrl('tok123')).toBe('/api/share/tok123/content');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @primer/web test -- src/lib/shareViewer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper module**

```ts
// apps/web/src/lib/shareViewer.ts
export function isPlausibleEmail(email: string): boolean {
  const e = email.trim();
  return e.length > 0 && e.length <= 320 && e.includes('@') && !e.startsWith('@') && !e.endsWith('@');
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function contentUrl(shareToken: string): string {
  return `/api/share/${shareToken}/content`;
}

/** Plain fetch with the CSRF header. Deliberately NOT lib/fetch.ts `api()`:
 *  its 401 handler redirects to the internal Okta login. */
export async function shareApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Primer-Csrf', '1');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...init, headers });
}
```

- [ ] **Step 4: Run helper tests to verify pass**

Run: `pnpm --filter @primer/web test -- src/lib/shareViewer.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the page component**

```tsx
// apps/web/src/routes/share.tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { isPlausibleEmail, isCompleteCode, contentUrl, shareApi } from '../lib/shareViewer.ts';

type Step =
  | { kind: 'checking' }
  | { kind: 'email' }
  | { kind: 'code'; email: string }
  | { kind: 'ready'; documentTitle: string; published: boolean };

export function SharePage() {
  const { shareToken = '' } = useParams();
  useDocumentTitle('Shared document — Primer');
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await shareApi(`/api/share/${shareToken}/session`);
      const body = (await res.json().catch(() => null)) as
        | { authenticated: boolean; documentTitle?: string; published?: boolean }
        | null;
      if (cancelled) return;
      if (body?.authenticated) {
        setStep({ kind: 'ready', documentTitle: body.documentTitle ?? '', published: body.published ?? false });
      } else {
        setStep({ kind: 'email' });
      }
    })();
    return () => { cancelled = true; };
  }, [shareToken]);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!isPlausibleEmail(email) || busy) return;
    setBusy(true);
    setError(null);
    const res = await shareApi(`/api/share/${shareToken}/request-code`, {
      method: 'POST',
      body: JSON.stringify({ email: email.trim() }),
    });
    setBusy(false);
    if (res.status === 503) {
      setError('Email delivery is not available right now. Please contact the person who shared this document.');
      return;
    }
    if (res.status === 429) {
      setError('Too many requests. Please wait a minute and try again.');
      return;
    }
    // Enumeration-safe by design: we always proceed to the code screen.
    setStep({ kind: 'code', email: email.trim() });
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code' || !isCompleteCode(code) || busy) return;
    setBusy(true);
    setError(null);
    const res = await shareApi(`/api/share/${shareToken}/verify`, {
      method: 'POST',
      body: JSON.stringify({ email: step.email, code }),
    });
    setBusy(false);
    if (res.ok) {
      // Cookie is set; the content endpoint takes it from here (top-level nav).
      window.location.assign(contentUrl(shareToken));
      return;
    }
    if (res.status === 429) {
      setError('Too many attempts. Please wait a minute and try again.');
    } else {
      setError("That code didn't work. Check it and try again, or request a new one.");
    }
  }

  return (
    // BRAND PASS: apply polygon-core:polygon-brand tokens to this shell.
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-8 shadow-sm">
        {/* BRAND PASS: replace with the Polygon wordmark/logo asset. */}
        <p className="text-sm font-semibold tracking-wide text-neutral-500 mb-6">POLYGON · Primer</p>

        {step.kind === 'checking' && (
          <p className="text-sm text-neutral-500">Checking access…</p>
        )}

        {step.kind === 'email' && (
          <form onSubmit={submitEmail}>
            <h1 className="text-lg font-semibold mb-1">A document has been shared with you</h1>
            <p className="text-sm text-neutral-500 mb-6">
              Enter your email address. If it has access, we'll send you a verification code.
            </p>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm mb-4"
            />
            <button
              type="submit"
              disabled={!isPlausibleEmail(email) || busy}
              className="w-full rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 py-2 text-sm font-medium disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {step.kind === 'code' && (
          <form onSubmit={submitCode}>
            <h1 className="text-lg font-semibold mb-1">Check your email</h1>
            <p className="text-sm text-neutral-500 mb-6">
              If <span className="font-medium">{step.email}</span> has access, we've sent it a 6-digit code.
              The code expires in 10 minutes.
            </p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-center text-xl tracking-[0.5em] mb-4"
            />
            <button
              type="submit"
              disabled={!isCompleteCode(code) || busy}
              className="w-full rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 py-2 text-sm font-medium disabled:opacity-40"
            >
              {busy ? 'Verifying…' : 'View document'}
            </button>
            <button
              type="button"
              onClick={() => { setStep({ kind: 'email' }); setCode(''); setError(null); }}
              className="w-full mt-3 text-xs text-neutral-500 underline"
            >
              Use a different email or request a new code
            </button>
          </form>
        )}

        {step.kind === 'ready' && (
          <div>
            <h1 className="text-lg font-semibold mb-1">{step.documentTitle || 'Shared document'}</h1>
            {step.published ? (
              <>
                <p className="text-sm text-neutral-500 mb-6">You're verified on this device.</p>
                <a
                  href={contentUrl(shareToken)}
                  className="block w-full rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 py-2 text-center text-sm font-medium"
                >
                  Open document
                </a>
              </>
            ) : (
              <p className="text-sm text-neutral-500">
                Nothing is published to this share yet. Check back later, or contact the person who shared it.
              </p>
            )}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
```

Route registration in `apps/web/src/App.tsx` — add as a **sibling** of the AppShell object (external visitors must not mount AppShell, which fires authenticated queries):

```tsx
import { SharePage } from './routes/share.tsx';

const router = createBrowserRouter([
  { path: '/share/:shareToken', element: <SharePage /> },
  {
    element: <AppShell />,
    children: [
      // ...existing children unchanged
    ],
  },
]);
```

- [ ] **Step 6: Verify build + typecheck + manual smoke**

Run: `pnpm --filter @primer/web typecheck && pnpm --filter @primer/web build && pnpm --filter @primer/web test`
Expected: PASS.

Manual (dev flow, `AUTH_MODE=mock`, NoopNotifier logs codes to the API console): create a share + recipient via `curl` against the admin routes, open `http://localhost:5173/share/<token>`, walk email → code (from API log) → document renders full screen. **Hand off visual verification of the branded screens to the user — do not attempt headless-browser screenshots** (standing project rule).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/share.tsx apps/web/src/lib/shareViewer.ts apps/web/src/lib/shareViewer.test.ts apps/web/src/App.tsx
git commit -m "feat(web): external share landing with OTP verification"
```

---

### Task 10: Internal sharer UX — ExternalSharePanel + badge

**Files:**
- Create: `apps/web/src/queries/externalShare.ts`
- Create: `apps/web/src/components/ExternalSharePanel.tsx`
- Modify: `apps/web/src/components/ShareModal.tsx` (mount the panel at the bottom of the modal body)
- Modify: `apps/web/src/routes/document.tsx` (badge next to the title when `document.externallyShared`)

**Interfaces:**
- Consumes: Task 7 endpoints + shared DTOs; Task 8 `externallyShared` flag; `api()` from `lib/fetch.ts` (internal users — Okta redirect on 401 is correct here); `useDocument` from `queries/documents.ts` (provides doc + versions; if versions aren't on that query's payload, use the same versions query `document.tsx` already uses and pass them down).

- [ ] **Step 1: Query hooks**

```ts
// apps/web/src/queries/externalShare.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddExternalRecipientRequest, ExternalShareResponse } from '@primer/shared';
import { api } from '../lib/fetch.ts';

const key = (docId: string) => ['external-share', docId] as const;

export function useExternalShare(docId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(docId),
    enabled,
    queryFn: async (): Promise<ExternalShareResponse | null> => {
      const res = await api(`/api/documents/${docId}/external-share`);
      if (res.status === 403) return null; // not a manager: hide the panel
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ExternalShareResponse;
    },
  });
}

function useInvalidating<TArgs>(docId: string, fn: (args: TArgs) => Promise<Response>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      const res = await fn(args);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(docId) });
      void qc.invalidateQueries({ queryKey: ['document', docId] }); // badge flag
    },
  });
}

export function useCreateExternalShare(docId: string) {
  return useInvalidating<void>(docId, () =>
    api(`/api/documents/${docId}/external-share`, { method: 'POST' }));
}
export function useRevokeExternalShare(docId: string) {
  return useInvalidating<void>(docId, () =>
    api(`/api/documents/${docId}/external-share`, { method: 'DELETE' }));
}
export function useAddExternalRecipient(docId: string) {
  return useInvalidating<AddExternalRecipientRequest>(docId, (body) =>
    api(`/api/documents/${docId}/external-share/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
}
export function useRevokeExternalRecipient(docId: string) {
  return useInvalidating<{ recipientId: string }>(docId, ({ recipientId }) =>
    api(`/api/documents/${docId}/external-share/recipients/${recipientId}`, { method: 'DELETE' }));
}
export function usePublishExternalShare(docId: string) {
  return useInvalidating<{ versionId: string }>(docId, (body) =>
    api(`/api/documents/${docId}/external-share/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
}
```

(If the document-detail query key in `queries/documents.ts` differs from `['document', docId]`, match it exactly.)

- [ ] **Step 2: Panel component**

```tsx
// apps/web/src/components/ExternalSharePanel.tsx
import { useState } from 'react';
import {
  useExternalShare, useCreateExternalShare, useRevokeExternalShare,
  useAddExternalRecipient, useRevokeExternalRecipient, usePublishExternalShare,
} from '../queries/externalShare.ts';

interface Props {
  docId: string;
  versions: Array<{ id: string; versionNumber: number }>;
  latestVersionNumber: number | null;
}

export function ExternalSharePanel({ docId, versions, latestVersionNumber }: Props) {
  const share = useExternalShare(docId, true);
  const create = useCreateExternalShare(docId);
  const revokeShare = useRevokeExternalShare(docId);
  const addRecipient = useAddExternalRecipient(docId);
  const revokeRecipient = useRevokeExternalRecipient(docId);
  const publish = usePublishExternalShare(docId);
  const [email, setEmail] = useState('');
  const [publishTarget, setPublishTarget] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  if (share.isLoading || share.data === null) return null; // 403 → not a manager
  const data = share.data;

  return (
    <section className="mt-6 border-t border-neutral-200 dark:border-neutral-800 pt-4">
      <h3 className="text-sm font-semibold mb-1">External sharing</h3>
      <p className="text-xs text-neutral-500 mb-3">
        Share a published version with people outside Polygon. They verify with an emailed code.
      </p>

      {data && !data.emailEnabled && (
        <p className="mb-3 rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Email delivery is not configured on this server — external recipients cannot receive
          verification codes, so external sharing is currently non-functional.
        </p>
      )}

      {!data?.share && (
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm"
        >
          {create.isPending ? 'Creating…' : 'Enable external sharing'}
        </button>
      )}

      {data?.share && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={`${window.location.origin}/share/${data.share.shareToken}`}
              className="flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1 text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="text-xs underline"
              onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/share/${data.share!.shareToken}`)}
            >
              Copy link
            </button>
          </div>

          <div className="text-xs">
            {data.share.publishedVersionNumber === null ? (
              <p className="text-amber-600 font-medium">
                Nothing is published yet — external recipients can't see anything until you publish a version.
              </p>
            ) : (
              <p className="text-neutral-500">
                Externals see <strong>v{data.share.publishedVersionNumber}</strong>
                {latestVersionNumber !== null && data.share.publishedVersionNumber !== latestVersionNumber && (
                  <span className="text-amber-600"> — latest internal is v{latestVersionNumber}</span>
                )}
                . New uploads change nothing externally until re-published.
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <select
                value={publishTarget}
                onChange={(e) => setPublishTarget(e.target.value)}
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Choose version…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>v{v.versionNumber}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!publishTarget || publish.isPending}
                onClick={() => { publish.mutate({ versionId: publishTarget }); setPublishTarget(''); }}
                className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-3 py-1 text-xs font-medium disabled:opacity-40"
              >
                Publish to external
              </button>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              addRecipient.mutate({ email: email.trim() }, { onSuccess: () => setEmail('') });
            }}
            className="flex items-center gap-2"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@company.com"
              className="flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs"
            />
            <button type="submit" disabled={addRecipient.isPending} className="text-xs underline">
              Add recipient
            </button>
          </form>
          {addRecipient.isError && (
            <p className="text-xs text-red-600">{(addRecipient.error as Error).message === 'recipient_exists' ? 'That email already has access.' : 'Could not add recipient.'}</p>
          )}

          <ul className="space-y-1">
            {data.recipients.filter((r) => r.revokedAt === null).map((r) => (
              <li key={r.id} className="flex items-center justify-between text-xs">
                <span>
                  {r.email}
                  <span className="text-neutral-400 ml-2">
                    {r.firstViewedAt === null
                      ? 'never viewed'
                      : `${r.viewCount} view${r.viewCount === 1 ? '' : 's'}, last ${new Date(r.lastViewedAt!).toLocaleDateString()}`}
                    {' · expires '}{new Date(r.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revokeRecipient.mutate({ recipientId: r.id })}
                  className="text-red-600 underline"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>

          {!confirmRevoke ? (
            <button type="button" onClick={() => setConfirmRevoke(true)} className="text-xs text-red-600 underline">
              Revoke all external access
            </button>
          ) : (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-red-600">Ends all recipient access immediately. Sure?</span>
              <button type="button" onClick={() => { revokeShare.mutate(); setConfirmRevoke(false); }} className="text-red-600 font-semibold underline">
                Yes, revoke
              </button>
              <button type="button" onClick={() => setConfirmRevoke(false)} className="underline">Cancel</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount in ShareModal + badge on the doc page**

In `ShareModal.tsx`, at the bottom of the modal body (after the collaborator list, inside the dialog container), add:

```tsx
      <ExternalSharePanel
        docId={docId}
        versions={(doc.data?.versions ?? []).map((v) => ({ id: v.id, versionNumber: v.versionNumber }))}
        latestVersionNumber={doc.data?.versions?.[0]?.versionNumber ?? null}
      />
```

(with the import; if `useDocument`'s payload doesn't carry `versions`, pass them from the same query `document.tsx` uses for its version selector — sorted newest-first, hence `[0]` for latest. Verify the sort order in that query and adjust.)

In `document.tsx`, next to the title header, render when `docQuery.data?.document.externallyShared` is true:

```tsx
  {docQuery.data?.document.externallyShared && (
    <span
      title="This document has an active external share"
      className="ml-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-[11px] font-medium align-middle"
    >
      Shared externally
    </span>
  )}
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @primer/web typecheck && pnpm --filter @primer/web build && pnpm --filter @primer/web test`
Expected: PASS. Manual: open a doc as owner → ShareModal shows the panel; enable, add recipient, publish, see the warning states. Hand off visual check to the user.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/queries/externalShare.ts apps/web/src/components/ExternalSharePanel.tsx apps/web/src/components/ShareModal.tsx apps/web/src/routes/document.tsx
git commit -m "feat(web): external sharing panel, publish flow, and doc badge"
```

---

### Task 11: End-to-end integration test (full lifecycle through HTTP only)

**Files:**
- Create: `apps/api/src/test/externalShareFlow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–7 via HTTP; `CaptureNotifier` pattern from Task 6's test file (duplicate the small class here — test files don't share helpers in this codebase).

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/test/externalShareFlow.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier, type NotifyExternalOtpArgs, type NotifyExternalFirstViewArgs } from '../notifications/notifier.ts';
import { _resetRateLimiterForTests } from '../lib/rateLimiter.ts';
import { CSRF_HEADERS, asUserJson, asUser } from '../test/harness.ts';

class CaptureNotifier extends NoopNotifier {
  override readonly emailEnabled = true;
  otps: NotifyExternalOtpArgs[] = [];
  firstViews: NotifyExternalFirstViewArgs[] = [];
  override async notifyExternalOtp(a: NotifyExternalOtpArgs): Promise<void> { this.otps.push(a); }
  override async notifyExternalFirstView(a: NotifyExternalFirstViewArgs): Promise<void> { this.firstViews.push(a); }
}

const JSON_HEADERS = { ...CSRF_HEADERS, 'content-type': 'application/json' };

describe('external sharing: full lifecycle over HTTP', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('create → recipient → publish → OTP → view → audit → revoke → dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-e2e-ext-'));
    const notifier = new CaptureNotifier();
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier });

      // Internal user uploads a doc.
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>Deal Deck</h1></body></html>'], { type: 'text/html' }), 'd.html');
      fd.append('title', 'Deal Deck');
      const up = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      const { documentId, versionId } = (await up.json()) as { documentId: string; versionId: string };

      // Create share, add recipient, publish — all through the admin API.
      const created = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const { share } = (await created.json()) as { share: { shareToken: string } };
      await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'client@example.com' }),
      });
      await app.request(`/api/documents/${documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId }),
      });

      // External client: request code → verify → view. No internal auth headers.
      await app.request(`/api/share/${share.shareToken}/request-code`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'client@example.com' }),
      });
      expect(notifier.otps.length).toBe(1);
      const verify = await app.request(`/api/share/${share.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code: notifier.otps[0].code }),
      });
      expect(verify.status).toBe(200);
      const cookie = verify.headers.get('set-cookie')!.split(';')[0];

      const view = await app.request(`/api/share/${share.shareToken}/content`, { headers: { cookie } });
      expect(view.status).toBe(200);
      expect(await view.text()).toContain('<h1>Deal Deck</h1>');
      expect(notifier.firstViews.length).toBe(1);
      expect(notifier.firstViews[0].sharerUserId).toBe('mock-user-1');

      // Sharer sees the engagement in the admin payload.
      const adminView = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      const adminBody = (await adminView.json()) as {
        recipients: Array<{ viewCount: number; firstViewedAt: string | null }>;
      };
      expect(adminBody.recipients[0].viewCount).toBe(1);
      expect(adminBody.recipients[0].firstViewedAt).not.toBeNull();

      // Kill switch: revoke the whole share → the existing session is dead.
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-1'),
      });
      const dead = await app.request(`/api/share/${share.shareToken}/content`, { headers: { cookie } });
      expect(dead.status).toBe(302);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @primer/api test -- src/test/externalShareFlow.test.ts`
Expected: PASS (everything already built; this proves the seams).

- [ ] **Step 3: Run everything**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: all workspace checks PASS (mirrors CI: typecheck, build, tests).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/externalShareFlow.test.ts
git commit -m "test(api): end-to-end external sharing lifecycle"
```

---

### Task 12: Spec amendment + wrap-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-07-external-document-sharing-design.md`

- [ ] **Step 1: Amend the spec's content-delivery paragraph**

In the "External viewer flow" section, replace the sentence describing viewer rendering (step 4) with:

```markdown
4. **View** — after verification the client navigates to
   `GET /api/share/:shareToken/content`, which serves the published version's
   HTML as a **top-level document** — identical delivery to the internal
   full-screen mode (`document.tsx` opens `/api/versions/:id/content`
   directly). A sandboxed iframe cannot be used here: sandboxed-iframe
   subresource requests are cross-site and strip the SameSite=Lax viewer
   cookie (see `apps/api/src/middleware/auth.ts`). The same strict
   `ARTIFACT_CSP` applies (`connect-src 'none'`, `form-action 'none'`), the
   cookie is HttpOnly, and unauthenticated/unpublished requests 302 back to
   the branded landing page. Each successful load writes an `external_views`
   row.
```

- [ ] **Step 2: Final verification sweep**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: PASS. Confirm with `git log --oneline` that each task landed as its own commit.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-07-external-document-sharing-design.md
git commit -m "docs: amend external sharing spec with top-level content delivery rationale"
```

**Do NOT push** — pushing (and the draft-PR/issue-board steps from CLAUDE.md) happens only on explicit user instruction.
