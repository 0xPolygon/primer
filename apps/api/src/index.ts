import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';
import { mockResolver, makeOktaResolver, type UserResolver } from './auth/resolver.ts';
import { OpenIdClientAdapter, makeDisabledOktaAdapter, type OktaAdapter } from './auth/okta.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();

const authMode = (process.env.AUTH_MODE ?? 'mock').toLowerCase();
if (authMode !== 'mock' && authMode !== 'okta') {
  throw new Error(`AUTH_MODE must be 'mock' or 'okta'; got '${authMode}'`);
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

const app = createApp({
  storage,
  notifier,
  userResolver,
  oktaAdapter,
  authCookieName: sessionCookieName,
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
