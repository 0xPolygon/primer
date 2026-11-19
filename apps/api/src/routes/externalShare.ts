import { pagePolicyOf, withFrozenRecords } from '../records/page.ts';
import { readFrozenRecords } from '../records/snapshot.ts';
import type { Hono, Context } from 'hono';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import { db } from '../db/client.ts';
import { externalViews } from '../db/schema.ts';
import { checkRateLimit } from '../lib/rateLimiter.ts';
import { parseCookie, serializeCookie } from '../auth/cookies.ts';
import { issueOtp, verifyOtp } from '../external/otp.ts';
import {
  createViewerSession, lookupViewerSession,
  VIEWER_COOKIE_NAME, VIEWER_SESSION_TTL_MS,
} from '../external/session.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import { logger } from '../logger.ts';

const GENERIC_OK = { ok: true } as const;

// IP-keyed limits are best-effort: behind a proxy the leftmost x-forwarded-for
// header is client-controlled and therefore spoofable. Per-email and per-share
// keys (plus the DB attempt cap in verifyOtp) are the real backstops.
function clientIp(c: Context<{ Variables: AppVariables }>): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

function viewerSessionId(c: Context<{ Variables: AppVariables }>): string | null {
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
    const shareToken = c.req.param('shareToken');
    if (
      !checkRateLimit(`ext-otp-verify:ip:${clientIp(c)}`, 20) ||
      !checkRateLimit(`ext-otp-verify:email:${email.toLowerCase()}`, 10) ||
      !checkRateLimit(`ext-otp-verify:share:${shareToken}`, 60)
    ) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const recipient = await findActiveRecipient(shareToken, email);
    // Unknown email and wrong code are indistinguishable by design.
    if (!recipient) return c.json({ error: 'invalid_code' }, 400);
    const ok = await verifyOtp(recipient.recipientId, code);
    if (!ok) return c.json({ error: 'invalid_code' }, 400);

    const session = await createViewerSession(
      recipient.recipientId,
      c.req.header('user-agent') ?? null,
    );
    // Secure flag: prefer explicit COOKIE_SECURE, else derive from AUTH_BASE_URL.
    // Request URL cannot be used: production runs plain HTTP behind a TLS-terminating
    // proxy, so c.req.url will always show http:// even on an HTTPS deploy.
    const secure =
      process.env.COOKIE_SECURE === 'true' ||
      (process.env.AUTH_BASE_URL ?? '').startsWith('https://');
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
  // would not (see middleware/auth.ts:22-29). Identical artifact CSP applies.
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
      SELECT id, storage_key AS "storageKey", bundle_key AS "bundleKey"
      FROM versions
      WHERE id = ${ctx.share.publishedVersionId}
      LIMIT 1
    `)) as unknown as Array<{ id: string; storageKey: string; bundleKey: string | null }>;
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

    // A checkpoint's record-reading page reads the records frozen at publish
    // (records.json), never live ones, under the records outbound lockdown.
    const stored = await new Response(await deps.storage.get(version.storageKey)).text();
    const html = version.bundleKey ? withFrozenRecords(stored, await readFrozenRecords(deps.storage, version.bundleKey)) : stored;
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp(pagePolicyOf(stored)),
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-store',
        'x-robots-tag': 'noindex',
      },
    });
  });
}
