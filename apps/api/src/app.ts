import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';
import { mockUserMiddleware } from './middleware/mockUser.ts';
import { registerUploadRoute } from './routes/upload.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerVersionContentRoute } from './routes/versionContent.ts';
import { registerCompanionRoute } from './routes/companion.ts';
import type { Storage } from '@primer/shared/storage';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export interface AppDeps {
  storage: Storage;
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', mockUserMiddleware);

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    appLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        user_id: c.get('user')?.id,
      },
      'request'
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  registerUploadRoute(app, deps);
  registerDocumentRoutes(app);
  registerVersionContentRoute(app, deps);
  registerCompanionRoute(app);

  return app;
}
