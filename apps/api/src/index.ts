import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { ResendNotifier } from './notifications/resend.ts';
import type { Notifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';
import { mockResolver, makeOktaResolver, type UserResolver } from './auth/resolver.ts';
import { OpenIdClientAdapter, makeDisabledOktaAdapter, type OktaAdapter } from './auth/okta.ts';
import { makeBearerResolver, composeResolvers } from './auth/bearer.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
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

const rawAuthMode = process.env.AUTH_MODE;
if (!rawAuthMode || !['mock', 'okta'].includes(rawAuthMode.toLowerCase())) {
  throw new Error(
    "AUTH_MODE must be explicitly set to 'mock' or 'okta'. " +
      "Refusing to start with an implicit default. " +
      'For local dev, set AUTH_MODE=mock in your .env file.',
  );
}
const authMode = rawAuthMode.toLowerCase();

if (authMode === 'mock' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_MODE=mock is not permitted when NODE_ENV=production. ' +
      'Set AUTH_MODE=okta and provide OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, AUTH_BASE_URL.',
  );
}
if (authMode === 'mock') {
  logger.warn(
    'AUTH_MODE=mock — every request is authenticated as mock-user-1. Do not deploy this to any shared environment.',
  );
}

const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? 'primer_sid';

let userResolver: UserResolver;
let oktaAdapter: OktaAdapter;

if (authMode === 'okta') {
  const issuer = process.env.OKTA_ISSUER;
  const clientId = process.env.OKTA_CLIENT_ID;
  const clientSecret = process.env.OKTA_CLIENT_SECRET;
  const authBaseUrl = process.env.AUTH_BASE_URL;
  if (!issuer || !clientId || !clientSecret || !authBaseUrl) {
    throw new Error(
      'AUTH_MODE=okta but one of OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, AUTH_BASE_URL is missing.'
    );
  }
  userResolver = makeOktaResolver({ cookieName: sessionCookieName });
  oktaAdapter = new OpenIdClientAdapter({
    issuer,
    clientId,
    clientSecret,
    redirectUri: `${authBaseUrl.replace(/\/$/, '')}/auth/callback`,
    scope: 'openid profile email',
  });
} else {
  userResolver = mockResolver;
  oktaAdapter = makeDisabledOktaAdapter();
}

// Bearer (PAT) auth runs first; falls through to the session/mock resolver
// when no `Authorization: Bearer primer_pat_...` header is present.
userResolver = composeResolvers(makeBearerResolver(), userResolver);

const app = createApp({
  storage,
  notifier,
  userResolver,
  oktaAdapter,
  authCookieName: sessionCookieName,
  authBaseUrl: process.env.AUTH_BASE_URL,
});

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot, authMode }, 'primer api listening');
});

const shutdown = async () => {
  await stopPurge();
  if ('close' in server) {
    (server as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
