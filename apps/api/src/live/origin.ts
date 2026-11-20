import type { AuthUser } from '../app.ts';

/** Who made a change to a live document. Stable identity is
 *  `(actorId, runId)`, never object identity. */
export type LiveOrigin = {
  kind: 'person' | 'agent' | 'system';
  actorId: string;
  runId: string | null;
};

export const SYSTEM_ORIGIN: LiveOrigin = { kind: 'system', actorId: 'system', runId: null };

export function originFor(user: AuthUser, runId: string | null = null): LiveOrigin {
  return { kind: user.kind, actorId: user.id, runId };
}

/**
 * Attribution of a Yjs transaction on a Hocuspocus document:
 * - `source: 'local'` (a DirectConnection, i.e. `applyPlan`) carries a
 *   LiveOrigin as its context;
 * - `source: 'connection'` (a WebSocket peer) carries the connection, whose
 *   context holds the authenticated user;
 * - anything else is the system.
 */
export function originOf(origin: unknown): LiveOrigin {
  if (typeof origin !== 'object' || origin === null || !('source' in origin)) return SYSTEM_ORIGIN;
  const o = origin as { source: string; context?: unknown; connection?: { context?: { user?: AuthUser } } };
  if (o.source === 'local' && isLiveOrigin(o.context)) return o.context;
  if (o.source === 'connection' && o.connection?.context?.user) return originFor(o.connection.context.user);
  return SYSTEM_ORIGIN;
}

function isLiveOrigin(value: unknown): value is LiveOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === 'person' || v.kind === 'agent' || v.kind === 'system') &&
    typeof v.actorId === 'string' &&
    (v.runId === null || typeof v.runId === 'string')
  );
}
