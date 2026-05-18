# Primer Sub-Project 5 — Auth + Ownership (design spec)

**Status:** approved, ready for implementation plan
**Date:** 2026-05-18
**Predecessor specs:** [SP1 local foundation](./2026-05-13-primer-local-foundation-design.md), [SP4 versioning + soft-delete](./2026-05-17-primer-versioning-soft-delete-design.md)

## Goal

Replace Primer's mock-user middleware with real Polygon Okta OIDC authentication, persist sessions in Postgres, enforce uploader-only authorization end-to-end at the API layer (currently effectively untestable with a single mock identity), and prepare the app for its first real deploy on Railway. After SP5, two distinct Polygon employees can sign in and exercise ownership boundaries.

This is the first sub-project in Phase 2 ("connect to the real world"). SP6 (Slack notifications) and SP7 (element-path fallback + alpha launch) depend on SP5 landing.

## Non-goals

See [Section 7 — Out of scope](#section-7--out-of-scope) for the full list. Headline exclusions: no Slack wiring (SP6), no custom domain in this round, no "log out everywhere" admin button, no service-to-service auth.

---

## Section 1 — Architecture overview

The pipeline shift: `mockUserMiddleware` (set fixed user, done) becomes a two-stage real pipeline.

```
Browser request
    │
    ├─ Carries cookie  primer_sid=<opaque>   (HttpOnly, Secure, SameSite=Lax)
    │
    ▼
authMiddleware (replaces mockUserMiddleware on every route)
    1. Read primer_sid cookie
    2. SELECT user FROM sessions JOIN users WHERE sid = ? AND expires_at > now()
    3. If found: c.set('user', { id, email, displayName }); next()
       If not + route starts with /api → 401 JSON
       If not + page route             → 302 /auth/login?return_to=<url>
    │
    ▼
csrfMiddleware (only on mutating verbs: POST/PATCH/PUT/DELETE for /api/*)
    Reject with 403 unless X-Primer-Csrf: 1 is set
    (applies to /api/* mutating verbs AND POST /auth/logout)
    │
    ▼
Route handler  (uses c.get('user') exactly like SP1–4 did — predicate unchanged)
```

The user resolver is **injected through `AppDeps`**, not hardcoded. `createApp({ storage, notifier, userResolver })`. In production, `userResolver` does the cookie+DB lookup. In dev with `AUTH_MODE=mock`, it returns the mock user. In tests, the harness can pass a resolver that reads an `X-Mock-User-Id` header. The auth swap is localized to that one injection point — no test file changes outside the harness.

**Three new auth endpoints** on the Hono app (one new file `apps/api/src/routes/auth.ts`):
- `GET /auth/login` — generate PKCE + nonce, store in a short-lived `auth_state` cookie, 302 to Okta's `authorization_endpoint`.
- `GET /auth/callback` — receive `code`, validate state/nonce, exchange code for tokens via Okta's token endpoint, upsert `users` row, insert `sessions` row, set `primer_sid` cookie, 302 to `return_to`.
- `POST /auth/logout` — delete the `sessions` row, clear the `primer_sid` cookie, return 204.

`openid-client` (Filip Skokan's library, the canonical Node OIDC RP) handles PKCE generation, state/nonce validation, token exchange, and ID-token verification. We do not roll those by hand.

**One exempt route**: `GET /api/health`. Everything else (including iframe-fetched `/api/versions/:vid/content` and `/api/companion/v1.js`) requires a valid session — the iframe `src` is same-origin so cookies travel.

---

## Section 2 — Data model

One new table.

```ts
// packages/shared/src/schema.ts (append)

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),                                   // opaque 32-byte random hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),                                 // nullable; informational only, never used in auth logic
  },
  (t) => ({
    byUser: index('sessions_user_id_idx').on(t.userId),
    byExpiry: index('sessions_expires_at_idx').on(t.expiresAt),
  })
);
```

**Lookup query** (one-shot, runs once per authenticated request):

```sql
SELECT u.id, u.email, u.display_name
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.id = $1 AND s.expires_at > now()
```

**Session TTL:** 14 days from creation, refreshed (sliding) by updating `last_seen_at` on each request and extending `expires_at = now() + interval '14 days'` only when the existing `expires_at` is less than 7 days out. Avoids a write on every request while keeping active users signed in.

**Cleanup:** a `purgeExpiredSessions` function in the existing `apps/api/src/jobs/purge.ts`, run from the same `startPurgeInterval` tick. `DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`. Cheap, idempotent.

**`users` table changes:** none to the schema, but two columns get real values for the first time:
- `id` ← Okta `sub` claim (was `'mock-user-1'`).
- `email`, `displayName` ← Okta `email` + `name` claims, upserted on every login (so name changes propagate).
- `slackUserId` stays null until SP6.

**No data migration.** Dev/local DBs with `mock-user-1` records won't match any Okta `sub`. We accept the orphan mock rows in dev DBs; SP5 does not try to merge them.

---

## Section 3 — API surface

**Three auth endpoints** in a new `apps/api/src/routes/auth.ts`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login` | Begin OIDC flow. Generates PKCE verifier + state + nonce, stores them in a short-lived `auth_state` cookie (HttpOnly, SameSite=Lax, 10 min TTL), 302s to Okta's `authorization_endpoint`. Accepts optional `?return_to=<path>` query (only same-origin paths allowed; defaults to `/`). |
| GET | `/auth/callback` | Receive `code` + `state` from Okta. Validate state matches the cookie. Exchange code for tokens via `openid-client`. Validate ID token (issuer, audience, nonce, expiry). Upsert the `users` row from claims. Insert a `sessions` row, set the `primer_sid` cookie. Clear the `auth_state` cookie. 302 to the stored `return_to`. |
| POST | `/auth/logout` | Delete the session row matching the cookie. Clear `primer_sid`. Return 204. |

**One identity endpoint** in `apps/api/src/routes/me.ts`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Return the current user's `{ id, email, displayName }`. Used by the frontend to know who's logged in and compare against `document.uploaderId` for ownership checks. |

**DTO addition** — `DocumentDetailResponse.document` gains `uploaderId: string`. The SP4 placeholder (`uploaderDisplayName === 'Mock User'`) is removed; the frontend predicate becomes `document.uploaderId === me.id`.

**Two new middlewares** replace `mockUserMiddleware` in `apps/api/src/app.ts`:

- **`authMiddleware`** — calls the injected `userResolver`, sets `c.var.user`, returns 401 (API) or 302 to `/auth/login?return_to=<url>` (page route). Path classification: `/api/*` and `/auth/*` are API/system; everything else is treated as a page route that needs the redirect. Exception: `/api/health` is fully public.
- **`csrfMiddleware`** — applied to every `POST/PATCH/PUT/DELETE` route except the OIDC callback (`GET /auth/callback` is a GET, not a mutating verb, so it's naturally excluded). Concretely: all `/api/*` mutating endpoints AND `POST /auth/logout`. Rejects with 403 unless `X-Primer-Csrf: 1` is set. GET endpoints (companion script, version content, login start, login callback) are unaffected.

**Auth swap point in `createApp`:**

```ts
// AppDeps gains:
userResolver: UserResolver  // resolves the current user from the request

// authMiddleware wraps the resolver:
async (c, next) => {
  const user = await deps.userResolver(c);
  if (!user) {
    if (isApiOrAuthPath(c.req.path)) return c.json({ error: 'unauthenticated' }, 401);
    return c.redirect(`/auth/login?return_to=${encodeURIComponent(c.req.path)}`, 302);
  }
  c.set('user', user);
  await next();
}
```

**Three resolver implementations** in `apps/api/src/auth/resolver.ts`:
- `oktaResolver` — cookie+DB lookup. Used in production.
- `mockResolver` — returns a fixed `MOCK_USER`. Used in dev when `AUTH_MODE=mock` and in single-user tests (the default).
- `mockMultiResolver` — returns the user whose id matches the `X-Mock-User-Id` header. If the header is absent, defaults to `mock-user-1`. If a row for that id doesn't exist in `users`, returns the mock user. Used only in multi-user tests via the `withMockUser()` harness helper.

`apps/api/src/index.ts` picks the resolver based on `AUTH_MODE`. Tests pass their resolver directly to `createApp`.

---

## Section 4 — Frontend changes

**New query** — `useMe()` in `apps/web/src/queries/me.ts`. Fetches `GET /api/me` with `staleTime: Infinity`. Available app-wide. Pages that need the current user's id (currently DocumentPage for the uploader check) read `me.data?.id`.

**Header UI** in `apps/web/src/AppShell.tsx`. The existing header gains a right-aligned identity widget:

```
┌─────────────────────────────────────────────────────────┐
│  Primer                              Taylan Pince  [▾]  │
└─────────────────────────────────────────────────────────┘
```

`[▾]` opens a small dropdown with one item: **Sign out**. Clicking it calls `POST /auth/logout` (with the CSRF header), then redirects to `/` (which forced-redirects to Okta if the user re-visits).

**Fetch wrapper** in `apps/web/src/lib/fetch.ts`. A thin `api(path, init)` helper that:
1. Sets `X-Primer-Csrf: 1` on every request.
2. If response is `401`, redirects the whole window to `/auth/login?return_to=<current path>`. This handles mid-session expiry — user is bounced through Okta and lands back where they were.

All existing fetches in `apps/web/src/queries/*` and `apps/web/src/components/*` migrate to use this wrapper. No business-logic changes; pure call-site substitution.

**Uploader predicate fix** in `DocumentPage`: replace the SP4 placeholder `isUploader = ... === 'Mock User'` with `isUploader = me.data?.id === document.uploaderId`. The placeholder comment is removed.

**No login page** — by Q4 decision (forced redirect). Logged-out users never see Primer's UI; they see Okta's, then they're back on Primer.

---

## Section 5 — Local dev, testing, multi-user

### Local dev

**Default behavior** — `pnpm dev` runs with `AUTH_MODE=mock`. Same as today: every request gets `mock-user-1`. No Okta dependency. Fast iteration. The mock user gets seeded into the DB on boot if missing.

**Opt-in real Okta** — `AUTH_MODE=okta` + the dev `.env` values (`OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `AUTH_BASE_URL=http://localhost:3000`, `SESSION_COOKIE_NAME=primer_sid`). The localhost callback (`http://localhost:3000/auth/callback`) is one of the URLs we ask IT to allow. Engineers flip the flag to walk the full real flow before deploying.

### Testing

Tests stay on the `mock` resolver by default — SP1–SP4 fixtures keep passing unchanged.

**New harness helper:** `withMockUser(userId, fn)` swaps in `mockMultiResolver` and sets the `X-Mock-User-Id` header for the duration of the request.

**Cross-user test coverage (6–8 cases):**
- `PATCH /api/documents/:id` by non-uploader → 403
- `DELETE /api/documents/:id` by non-uploader → 403
- `POST /api/documents/:id/versions` by non-uploader → 403
- `POST /api/documents/:id/restore` by non-uploader → 403
- `PATCH /api/versions/:vid` by non-uploader → 403
- Comments rendered with correct author labels when authored by different users
- `GET /api/me` returns the active user (different result for each `X-Mock-User-Id`)
- Existing same-user happy paths still pass for `mock-user-1`

**Auth-specific tests:**
- `/auth/login` 302s to Okta's authorization endpoint with PKCE params (code_challenge + state + nonce in the redirect URL)
- `/auth/callback` with a stubbed Okta token endpoint creates a session, sets the cookie, upserts the user from claims
- `/auth/callback` rejects mismatched state, missing nonce, expired/invalid ID token
- `/auth/logout` deletes the session row, clears the cookie, returns 204
- `authMiddleware` returns 401 on `/api/*` without a session, 302 on page routes
- `csrfMiddleware` returns 403 on POST without the header, lets GETs through

For the Okta token endpoint we use `msw` or a small `fetch`-mock — `openid-client`'s discovery + token exchange both go through global `fetch` and can be intercepted.

### Multi-user smoke after deploy

Once Primer is live on Railway:
1. Sign in as yourself, upload a doc, add a thread.
2. Sign out (or open an incognito window).
3. Sign in as a second Polygon employee. Open someone else's doc, comment, reply.
4. Confirm: thread author labels match the actual authors; trying to delete a doc you don't own returns 403; the `+ Version` button is hidden on docs you don't own; the `⋯` menu is hidden on docs you don't own.

~15 minute exercise. Tracked in the deployment checklist (Section 6).

---

## Section 6 — Deployment & IT handoff

This is the gating dependency for SP5 going live.

### IT request (Slack `@assist`)

Once SP5 code is on `master` and we have the Railway URL generated, we ask IT for one Okta OIDC application registration for Primer with this config:

```
App type:       Web application (confidential client)
Application:    Primer
Audience:       Polygon employees (all who have access to internal tooling)
Grant types:    authorization_code
PKCE:           required
Sign-in URIs / Redirect URIs (allowed callbacks):
  - http://localhost:3000/auth/callback                       (dev — for engineers)
  - https://<railway-default>.up.railway.app/auth/callback    (prod)
Sign-out URI:   not used (Q5 → local logout only; no RP-initiated)
Scopes:         openid, profile, email
Claims needed:  sub, email, name
```

IT confirms the registration and hands back `client_id` and `client_secret`. We do not ask for a custom domain in SP5 — that's a future tiny ticket flipping the callback URL when DNS for `primer.polygon.technology` (or similar) is ready.

### Env vars Primer reads

No secrets in git; populated in Railway service environment for prod and local `.env` for dev opt-in:

```
AUTH_MODE                   = okta | mock                # mock in dev default, okta in prod
OKTA_ISSUER                 = https://<polygon-tenant>.okta.com    # provided by IT
OKTA_CLIENT_ID              = <provided by IT>
OKTA_CLIENT_SECRET          = <provided by IT, Railway-only>
AUTH_BASE_URL               = http://localhost:3000               (dev)
                            | https://<railway>.up.railway.app    (prod)
SESSION_COOKIE_NAME         = primer_sid
SESSION_TTL_DAYS            = 14                                   (optional; defaults to 14)
```

`AUTH_BASE_URL` is what we pass to `openid-client` as the redirect URI base — it must match what IT registered.

### Railway deployment steps

One-time, separately tracked from the implementation plan. Drive these through the `polygon-deploy` skill:

1. Create the GitHub repo (`0xPolygon/primer`).
2. Run `polygon-deploy`: App Audit → Railway pre-flight → Deploy → Generate Domain.
3. Take the generated `*.up.railway.app` URL, give it to IT in the Slack request above.
4. Receive `client_id` / `client_secret`. Set Railway env vars.
5. Wire managed Postgres (Railway's add-on or Supabase). Set `DATABASE_URL`. Run migrations from a one-off Railway command.
6. Confirm `pnpm db:purge` can be run as a scheduled Railway cron (or accept the in-process interval — both work).
7. Multi-user smoke per Section 5.

**This is outside the code plan.** The implementation plan ends at "code on `master` and ready to deploy." The deploy itself is operational and driven manually through `polygon-deploy`.

### Security audit

Runs automatically as part of `polygon-deploy` (the App Auditor Slack workflow). Between that and Primer's own SP4 final review, this should clear without findings.

---

## Section 7 — Out of scope

Deliberate exclusions for SP5. All deferred to later sub-projects or future small tickets:

- **Slack notifier wiring.** SP6. `users.slackUserId` stays null.
- **@mention typeahead from the Okta directory.** SP6.
- **Custom domain.** Q6 → A. Launch on `*.up.railway.app`. Tiny follow-up flips the Okta callback URL when DNS is ready.
- **"Log out everywhere" / kill all sessions.** Q5 → A. Local logout only. The data is there in the `sessions` table if we ever need a one-liner admin tool.
- **Active-devices UI.** `sessions.userAgent` + `lastSeenAt` are recorded but unexposed. Cheap to add later if anyone asks.
- **Brute-force / rate limiting on `/auth/*`.** Okta handles auth attempts on its side. Primer's `/auth/callback` validates tokens cryptographically — there's no password to brute-force here.
- **Audit log of sign-ins.** The `sessions` table is effectively a sign-in log already (each row = one sign-in). No separate admin view in SP5.
- **Two-account real Okta test in the implementation plan itself.** The plan ends at code-on-master. The two-account smoke (Section 5) is in the deployment checklist (Section 6 step 7), executed after deploy.
- **Migrating existing local dev data.** Dev DBs with `mock-user-1` records stay orphaned.
- **Service-to-service auth.** No machine clients. Everything is browser-driven.

---

## Decision log (Q1–Q8)

For traceability — the eight forks decided during brainstorming.

| # | Topic | Decision |
|---|---|---|
| 1 | Okta app registration status | Not registered yet; user will request via `@assist` once spec config is locked. Spec includes the IT-handoff config (Section 6). |
| 2 | Local dev story | Mock by default in dev (`AUTH_MODE=mock`); real Okta opt-in locally via `AUTH_MODE=okta` + localhost callback registered with IT. Tests on mock. |
| 3 | Session storage | Postgres `sessions` table with opaque session id cookie. |
| 4 | Login UX | Forced redirect — no SPA login page; logged-out users 302 through `/auth/login` → Okta → back. |
| 5 | Logout behavior | Local logout only. IdP session stays alive. No RP-initiated logout. |
| 6 | Deployment URL | Default Railway domain (`*.up.railway.app`). Custom domain is a future follow-up. |
| 7 | Multi-user testing | Parameterized mock middleware in tests (`withMockUser`) AND a manual two-real-account smoke after deploy. |
| 8 | CSRF protection | `SameSite=Lax` cookie + custom-header check (`X-Primer-Csrf: 1`) on mutating endpoints. |
