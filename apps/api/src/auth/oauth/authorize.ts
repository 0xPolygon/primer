import type { Context, Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { oauthAuthorizationCodes, oauthConsents } from '@primer/shared/schema';
import { parseCookie } from '../cookies.ts';
import { lookupSession } from '../session.ts';
import { generateAuthCode } from './tokens.ts';
import { getClient, type OAuthClientRow } from './clients.ts';

const CODE_TTL_MS = 5 * 60 * 1000;
const REQUIRED_SCOPE = 'primer';

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
}

function readParams(url: URL): AuthorizeParams {
  const q = url.searchParams;
  return {
    clientId: q.get('client_id') ?? '',
    redirectUri: q.get('redirect_uri') ?? '',
    responseType: q.get('response_type') ?? '',
    codeChallenge: q.get('code_challenge') ?? '',
    codeChallengeMethod: q.get('code_challenge_method') ?? '',
    state: q.get('state') ?? '',
    scope: q.get('scope') ?? REQUIRED_SCOPE,
  };
}

function readBodyParams(body: URLSearchParams): AuthorizeParams & { decision: string } {
  return {
    clientId: body.get('client_id') ?? '',
    redirectUri: body.get('redirect_uri') ?? '',
    responseType: body.get('response_type') ?? '',
    codeChallenge: body.get('code_challenge') ?? '',
    codeChallengeMethod: body.get('code_challenge_method') ?? '',
    state: body.get('state') ?? '',
    scope: body.get('scope') ?? REQUIRED_SCOPE,
    decision: body.get('decision') ?? '',
  };
}

function validateOauthParams(p: AuthorizeParams): { ok: true } | { ok: false; reason: string } {
  if (p.responseType !== 'code') return { ok: false, reason: 'response_type must be "code"' };
  if (p.codeChallengeMethod !== 'S256') return { ok: false, reason: 'code_challenge_method must be S256' };
  if (p.codeChallenge.length === 0) return { ok: false, reason: 'code_challenge is required' };
  if (p.state.length === 0) return { ok: false, reason: 'state is required' };
  return { ok: true };
}

function errorRedirect(c: Context, redirectUri: string, error: string, description: string, state: string) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return c.redirect(u.toString(), 302);
}

function errorPage(c: Context, error: string, description: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>OAuth error</title>
<h1>Authorization error</h1><p><code>${error}</code>: ${description}</p>`;
  return c.html(html, 400);
}

function renderConsent(c: Context, client: OAuthClientRow, p: AuthorizeParams, csrfToken: string) {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  const html = `<!doctype html><meta charset="utf-8">
<title>Authorize Primer connector</title>
<style>body{font-family:system-ui;max-width:38rem;margin:2rem auto;line-height:1.5}
.note{background:#f6f6f6;padding:.5rem .75rem;border-radius:.25rem;font-size:.9em;color:#555}
button{padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>An app calling itself &ldquo;${esc(client.clientName)}&rdquo; wants access to your Primer documents.</h1>
<p class="note">If you weren&rsquo;t expecting this prompt, click <strong>Deny</strong>.</p>
<form method="POST" action="/oauth/consent">
${hidden('client_id', p.clientId)}
${hidden('redirect_uri', p.redirectUri)}
${hidden('response_type', p.responseType)}
${hidden('code_challenge', p.codeChallenge)}
${hidden('code_challenge_method', p.codeChallengeMethod)}
${hidden('state', p.state)}
${hidden('scope', p.scope)}
${hidden('csrf', csrfToken)}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`;
  return c.html(html);
}

async function mintCodeAndRedirect(
  c: Context,
  input: { userId: string; clientId: string; p: AuthorizeParams },
) {
  const { code, codeHash } = generateAuthCode();
  await db.insert(oauthAuthorizationCodes).values({
    id: uuidv7(),
    codeHash,
    userId: input.userId,
    clientId: input.clientId,
    redirectUri: input.p.redirectUri,
    codeChallenge: input.p.codeChallenge,
    codeChallengeMethod: input.p.codeChallengeMethod,
    scopes: input.p.scope.split(' ').filter((s) => s.length > 0),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const u = new URL(input.p.redirectUri);
  u.searchParams.set('code', code);
  if (input.p.state) u.searchParams.set('state', input.p.state);
  return c.redirect(u.toString(), 302);
}

export interface AuthorizeOptions {
  sessionCookieName: string;
}

export function registerOAuthAuthorizationRoutes(app: Hono, opts: AuthorizeOptions): void {
  app.get('/oauth/authorize', async (c) => {
    const url = new URL(c.req.url, 'http://x');
    const p = readParams(url);

    const client = p.clientId ? await getClient(p.clientId) : null;
    if (!client) return errorPage(c, 'invalid_client', 'Unknown client_id');
    if (!client.redirectUris.includes(p.redirectUri))
      return errorPage(c, 'invalid_redirect_uri', 'redirect_uri not registered');

    const paramCheck = validateOauthParams(p);
    if (!paramCheck.ok) return errorRedirect(c, p.redirectUri, 'invalid_request', paramCheck.reason, p.state);

    const sid = parseCookie(c.req.header('cookie') ?? null, opts.sessionCookieName);
    const session = sid ? await lookupSession(sid) : null;
    if (!session) {
      const returnTo = encodeURIComponent(`${url.pathname}${url.search}`);
      return c.redirect(`/auth/login?return_to=${returnTo}`, 302);
    }

    const existing = (await db.execute(sql`
      SELECT id FROM oauth_consents
      WHERE user_id = ${session.user.id} AND client_id = ${p.clientId}
      LIMIT 1
    `)) as unknown as { id: string }[];

    if (existing.length > 0) {
      return mintCodeAndRedirect(c, { userId: session.user.id, clientId: p.clientId, p });
    }

    return renderConsent(c, client, p, sid);
  });

  app.post('/oauth/consent', async (c) => {
    const raw = await c.req.text();
    const body = new URLSearchParams(raw);
    const p = readBodyParams(body);

    const client = p.clientId ? await getClient(p.clientId) : null;
    if (!client) return errorPage(c, 'invalid_client', 'Unknown client_id');
    if (!client.redirectUris.includes(p.redirectUri))
      return errorPage(c, 'invalid_redirect_uri', 'redirect_uri not registered');

    const paramCheck = validateOauthParams(p);
    if (!paramCheck.ok) return errorRedirect(c, p.redirectUri, 'invalid_request', paramCheck.reason, p.state);

    const sid = parseCookie(c.req.header('cookie') ?? null, opts.sessionCookieName);
    const session = sid ? await lookupSession(sid) : null;
    if (!session) return errorPage(c, 'not_authenticated', 'session missing');

    if (p.decision !== 'allow') {
      return errorRedirect(c, p.redirectUri, 'access_denied', 'user denied consent', p.state);
    }

    // Upsert the consent row.
    await db.execute(sql`
      INSERT INTO oauth_consents (id, user_id, client_id, scopes, updated_at)
      VALUES (${uuidv7()}, ${session.user.id}, ${p.clientId}, ${JSON.stringify(p.scope.split(' ').filter((s) => s.length > 0))}, now())
      ON CONFLICT (user_id, client_id)
      DO UPDATE SET scopes = EXCLUDED.scopes, updated_at = now()
    `);

    return mintCodeAndRedirect(c, { userId: session.user.id, clientId: p.clientId, p });
  });
}
