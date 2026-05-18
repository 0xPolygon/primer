import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();
const app = createApp({ storage, notifier });

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot }, 'primer api listening');
});

const shutdown = async () => {
  await stopPurge();
  // Hono's @hono/node-server returns the underlying http.Server.
  if ('close' in server) {
    (server as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
