import type { Context } from 'hono';
import type { AppVariables } from '../app.ts';
import { parseCookie } from './cookies.ts';
import { lookupSession, refreshSessionIfStale } from './session.ts';

export type ResolvedUser = AppVariables['user'];

export type UserResolver = (
  c: Context<{ Variables: AppVariables }>
) => Promise<ResolvedUser | null>;

export const MOCK_USER: ResolvedUser = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
};

export const mockResolver: UserResolver = async (c) => {
  c.set('authMethod', 'mock');
  return MOCK_USER;
};

/** Reads `X-Mock-User-Id` from the request. Falls back to MOCK_USER's id when absent. */
export const mockMultiResolver: UserResolver = async (c) => {
  const headerId = c.req.header('x-mock-user-id');
  const id = headerId && headerId.trim().length > 0 ? headerId : MOCK_USER.id;
  c.set('authMethod', 'mock');
  // The middleware needs the FULL user (email + displayName). For tests we
  // don't read these from the DB — they're synthesized from the id.
  if (id === MOCK_USER.id) return MOCK_USER;
  return { id, email: `${id}@polygon.technology`, displayName: id };
};

export interface OktaResolverOptions {
  cookieName: string;
}

export function makeOktaResolver(opts: OktaResolverOptions): UserResolver {
  return async (c) => {
    const sid = parseCookie(c.req.header('cookie') ?? null, opts.cookieName);
    if (!sid) return null;
    const found = await lookupSession(sid);
    if (!found) return null;
    // Sliding refresh — fire and forget; refresh failures don't break the request.
    void refreshSessionIfStale(sid).catch(() => undefined);
    c.set('authMethod', 'cookie');
    return found.user;
  };
}
