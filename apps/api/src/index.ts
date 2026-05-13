import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const app = createApp({ storage });

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot }, 'primer api listening');
});
