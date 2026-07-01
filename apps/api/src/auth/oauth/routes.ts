import type { Hono } from 'hono';
import { registerOAuthMetadataRoutes } from './metadata.ts';
import { registerOAuthRegistrationRoute } from './register.ts';
import { registerOAuthAuthorizationRoutes } from './authorize.ts';
import { registerOAuthTokenRoute } from './token.ts';
import { registerOAuthRevocationRoute } from './revoke.ts';
import { oauthRateLimitMiddleware } from './rateLimit.ts';

export interface OAuthRoutesDeps {
  issuer: string;
  sessionCookieName: string;
}

export function registerOAuthRoutes(app: Hono<any>, deps: OAuthRoutesDeps): void {
  // Rate limits — mounted per-endpoint so bucket keys stay scoped.
  app.use('/oauth/register', oauthRateLimitMiddleware({ capacity: 5, refillPerSecond: 1 / 60 }));
  app.use('/oauth/authorize', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));
  app.use('/oauth/consent', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));
  app.use('/oauth/token', oauthRateLimitMiddleware({ capacity: 30, refillPerSecond: 1 / 2 }));
  app.use('/oauth/revoke', oauthRateLimitMiddleware({ capacity: 20, refillPerSecond: 1 / 3 }));

  registerOAuthMetadataRoutes(app, { issuer: deps.issuer });
  registerOAuthRegistrationRoute(app);
  registerOAuthAuthorizationRoutes(app, { sessionCookieName: deps.sessionCookieName });
  registerOAuthTokenRoute(app);
  registerOAuthRevocationRoute(app);
}
