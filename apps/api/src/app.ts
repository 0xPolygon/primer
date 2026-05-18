import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';
import { authMiddleware } from './middleware/auth.ts';
import { csrfMiddleware } from './auth/csrf.ts';
import { mockResolver, type UserResolver } from './auth/resolver.ts';
import { registerUploadRoute } from './routes/upload.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerVersionContentRoute } from './routes/versionContent.ts';
import { registerCompanionRoute } from './routes/companion.ts';
import { registerDevFixtureRoute } from './routes/devFixture.ts';
import { registerThreadRoutes } from './routes/threads.ts';
import { registerCommentRoutes } from './routes/comments.ts';
import { registerDashboardRoute } from './routes/dashboard.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoute } from './routes/me.ts';
import type { Storage } from '@primer/shared/storage';
import type { Notifier } from './notifications/notifier.ts';
import type { OktaAdapter } from './auth/okta.ts';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
  userResolver?: UserResolver;     // defaults to mockResolver (tests + dev)
  oktaAdapter?: OktaAdapter;            // NEW
  authCookieName?: string;              // NEW; defaults to 'primer_sid'
  authStateCookieName?: string;         // NEW; defaults to 'primer_auth_state'
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  const resolver = deps.userResolver ?? mockResolver;
  app.use('*', authMiddleware(resolver));
  app.use('*', csrfMiddleware);

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
  registerDocumentRoutes(app, deps);
  registerVersionContentRoute(app, deps);
  registerCompanionRoute(app);
  registerThreadRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerDashboardRoute(app);
  registerVersionRoutes(app);
  registerAuthRoutes(app, deps);
  registerMeRoute(app);

  if (process.env.NODE_ENV !== 'production') {
    registerDevFixtureRoute(app);
  }

  return app;
}
