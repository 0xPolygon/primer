// Dev-only mock-persona selector (AUTH_MODE=mock). Local testing of the
// live multi-party events relay (issue #78) needs TWO authenticated
// collaborators in different browsers at once; mockResolver alone signs
// every session in as the same MOCK_USER. This route lets a BROWSER pick
// which mock persona it is, via a session cookie the resolver reads:
//
//   GET /auth/mock                      → tiny HTML picker listing personas
//   GET /auth/mock?user=mock-user-2     → set primer_mock_user cookie, redirect
//
// SECURITY: this is local dev infrastructure, registered ONLY when
// AUTH_MODE=mock and NODE_ENV!=production (see app.ts) — the same gate that
// already refuses mock auth in production at boot (index.ts throws). Under
// AUTH_MODE=okta the route does not exist and the cookie is never read, so
// this adds zero surface there. The cookie is a convenience, never an
// authorization input: unknown values fall back to the default persona.
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { MOCK_USER, MOCK_USERS, MOCK_USER_COOKIE } from '../auth/resolver.ts';
import { serializeCookie } from '../auth/cookies.ts';

// One year: the persona choice should outlive any drill session; it is
// per-browser state with no security weight (see gate above).
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

function sanitizeReturnTo(input: string | undefined): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function registerMockAuthRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/auth/mock', (c) => {
    const requested = c.req.query('user');
    const returnTo = sanitizeReturnTo(c.req.query('return_to'));

    if (requested !== undefined) {
      const persona = MOCK_USERS.find((u) => u.id === requested);
      if (!persona) {
        return c.json(
          {
            error: 'unknown_mock_user',
            message: `user must be one of: ${MOCK_USERS.map((u) => u.id).join(', ')}`,
          },
          400,
        );
      }
      c.header(
        'set-cookie',
        serializeCookie(MOCK_USER_COOKIE, persona.id, {
          maxAge: COOKIE_MAX_AGE_SEC,
          httpOnly: true,
          secure: false, // local dev over http; the route never exists elsewhere
          sameSite: 'lax',
          path: '/',
        }),
      );
      return c.redirect(returnTo, 302);
    }

    // Picker page. `user` is who the CURRENT request resolved as (the
    // cookie already applies), so the active persona is marked.
    const current = c.get('user')?.id ?? MOCK_USER.id;
    const rows = MOCK_USERS.map((u) => {
      const active = u.id === current ? ' — <strong>current</strong>' : '';
      return `<li style="margin:6px 0">
        <a href="/auth/mock?user=${encodeURIComponent(u.id)}&return_to=${encodeURIComponent(returnTo)}">
          ${escapeHtml(u.displayName)}</a>
        <code style="margin-left:6px">${escapeHtml(u.id)}</code>
        <span style="color:#666;margin-left:6px">${escapeHtml(u.email)}</span>${active}
      </li>`;
    }).join('\n');
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Mock sign-in</title>
       <body style="font:14px system-ui;max-width:40rem;margin:3rem auto">
       <h1 style="font-size:18px">Mock sign-in (local dev)</h1>
       <p>Pick which mock persona THIS BROWSER acts as. Open a different
       browser (or private window) and pick another persona to test
       multi-user flows.</p>
       <ul style="list-style:none;padding:0">${rows}</ul>
       </body>`,
    );
  });
}
