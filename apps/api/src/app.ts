import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as appLogger } from './logger.ts';
import { authMiddleware } from './middleware/auth.ts';
import { csrfMiddleware } from './auth/csrf.ts';
import { mockResolver, type UserResolver } from './auth/resolver.ts';
import { registerUploadRoute } from './routes/upload.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerVersionContentRoute } from './routes/versionContent.ts';
import { registerCompanionRoute } from './routes/companion.ts';
import { registerMermaidAssetRoute } from './routes/mermaidAsset.ts';
import { registerDevFixtureRoute } from './routes/devFixture.ts';
import { registerThreadRoutes } from './routes/threads.ts';
import { registerCommentRoutes } from './routes/comments.ts';
import { registerDashboardRoute } from './routes/dashboard.ts';
import { registerAdminRoute } from './routes/admin.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoute } from './routes/me.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerDeviceRoutes } from './routes/device.ts';
import { registerTokenRoutes } from './routes/tokens.ts';
import { registerCollaboratorRoutes } from './routes/collaborators.ts';
import { registerOAuthRoutes } from './auth/oauth/routes.ts';
import { registerMcpRoute } from './mcp/routes.ts';
import type { Storage } from '@primer/shared/storage';
import type { Notifier } from './notifications/notifier.ts';
import type { OktaAdapter } from './auth/okta.ts';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
  authMethod?: 'bearer' | 'cookie' | 'mock';
};

export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
  userResolver?: UserResolver;     // defaults to mockResolver (tests + dev)
  oktaAdapter?: OktaAdapter;            // NEW
  authCookieName?: string;              // NEW; defaults to 'primer_sid'
  authStateCookieName?: string;         // NEW; defaults to 'primer_auth_state'
  authBaseUrl?: string;                 // NEW; base URL used in device verification links
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  const issuer = (
    process.env.OAUTH_ISSUER ??
    deps.authBaseUrl ??
    process.env.AUTH_BASE_URL ??
    ''
  ).replace(/\/$/, '');

  const resolver = deps.userResolver ?? mockResolver;
  app.use('*', authMiddleware(resolver, issuer.length > 0 ? { issuer } : undefined));
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
  registerCollaboratorRoutes(app, deps);
  registerVersionContentRoute(app, deps);
  registerCompanionRoute(app);
  registerMermaidAssetRoute(app);
  registerThreadRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerDashboardRoute(app);
  registerAdminRoute(app);
  registerVersionRoutes(app);
  registerAuthRoutes(app, deps);
  registerMeRoute(app);
  registerUserRoutes(app);
  registerDeviceRoutes(app, { baseUrl: deps.authBaseUrl ?? process.env.AUTH_BASE_URL ?? '' });
  registerTokenRoutes(app);

  if (issuer.length > 0) {
    registerOAuthRoutes(app, {
      issuer,
      sessionCookieName: deps.authCookieName ?? 'primer_sid',
    });
    registerMcpRoute(app, {
      storage: deps.storage,
      notifier: deps.notifier,
      apiBaseUrl: issuer,
    });
  }

  if (process.env.NODE_ENV !== 'production') {
    registerDevFixtureRoute(app);
  }

  // Production: serve the built SPA. Dev: Vite handles this at :5173, skip.
  if (process.env.SERVE_STATIC === '1') {
    // Default: resolve relative to this source file so the path is correct
    // regardless of cwd (Railway runs `pnpm --filter @primer/api start` from
    // either the repo root or the package dir depending on workspace settings).
    const here = dirname(fileURLToPath(import.meta.url));
    const staticRoot = process.env.STATIC_ROOT ?? resolvePath(here, '../../web/dist');
    app.use('/*', serveStatic({ root: staticRoot }));
    app.get('/*', async (c) => {
      const p = c.req.path;
      if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/companion/')) {
        return c.notFound();
      }
      // Only fall back to index.html for routes (no file extension after the last /).
      // Missing assets like /assets/foo.js stay as 404 so we don't mask bad bundle paths.
      const last = p.slice(p.lastIndexOf('/') + 1);
      if (last.includes('.')) return c.notFound();
      try {
        const html = await readFile(resolvePath(staticRoot, 'index.html'), 'utf-8');
        return c.html(html);
      } catch {
        return c.text('SPA build missing', 500);
      }
    });
  }

  return app;
}
