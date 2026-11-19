import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { ApiTokenScope } from '@polygonlabs/primer-api-types';
import type { AppVariables, AuthUser } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { canEdit, canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';

/** Who opened a live connection, resolved once from the upgrade request. */
export type LiveAuth = {
  user: AuthUser;
  authMethod: 'bearer' | 'cookie' | 'mock';
  scopes?: readonly ApiTokenScope[];
};

/** The per-connection Hocuspocus context: `auth` from the upgrade, `user`
 *  and `documentId` added once the document is authorised. */
export type LiveContext = { auth?: LiveAuth; user?: AuthUser; documentId?: string };

/**
 * Runs Primer's resolver chain (OAuth, PAT, session or mock, and the proxy
 * resolver when configured) against request headers, through a minimal stand-in
 * for the Hono context the resolvers read (`req.header`) and write
 * (`set('authMethod' | 'tokenScopes')`).
 */
export async function resolveFromHeaders(resolver: UserResolver, headers: Headers): Promise<LiveAuth | null> {
  const vars = new Map<string, unknown>();
  const shim = {
    req: { header: (name: string) => headers.get(name) ?? undefined },
    set: (key: string, value: unknown) => void vars.set(key, value),
    get: (key: string) => vars.get(key),
  } as unknown as Context<{ Variables: AppVariables }>;
  const user = await resolver(shim);
  if (!user) return null;
  const authMethod = (vars.get('authMethod') as LiveAuth['authMethod'] | undefined) ?? 'cookie';
  const scopes = vars.get('tokenScopes') as readonly ApiTokenScope[] | undefined;
  return scopes ? { user, authMethod, scopes } : { user, authMethod };
}

/**
 * What a connection may do on a live document: `none` (stranger, deleted,
 * legacy, or a scoped token without documents:read), `read` (readers, and
 * every bearer connection: agents write only through ops), or `write`
 * (owner and editors).
 */
export async function liveAccess(auth: LiveAuth, documentId: string): Promise<'none' | 'read' | 'write'> {
  if (auth.scopes && !auth.scopes.includes('documents:read')) return 'none';
  const [doc] = (await db.execute(sql`
    SELECT id, uploader_id AS "uploaderId", visibility, deleted_at AS "deletedAt", format
      FROM documents WHERE id = ${documentId} LIMIT 1
  `)) as unknown as { id: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null; format: string | null }[];
  if (!doc || doc.deletedAt !== null || doc.format === null) return 'none';
  const role = await loadEffectiveRole(doc, auth.user);
  if (!canRead(doc.visibility, role)) return 'none';
  return auth.authMethod !== 'bearer' && canEdit(role) ? 'write' : 'read';
}
