import { logger } from '../logger.ts';

/**
 * Which open live connections to recheck now: those on a document, those of a
 * user, or those opened with one bearer credential (sha-256 hex of the token,
 * the hash PATs and OAuth access tokens are stored under).
 */
export type LiveMatch = { documentId: string } | { userId: string } | { credentialHash: string };

let recheck: ((match: LiveMatch) => Promise<void>) | null = null;

/** The hub registers how it rechecks (live/hub.ts). */
export function onLiveRecheck(fn: (match: LiveMatch) => Promise<void>): () => void {
  recheck = fn;
  return () => {
    if (recheck === fn) recheck = null;
  };
}

/**
 * Called by every handler that removes credentials or access (token and
 * agent-token revocation, OAuth revocation, logout, collaborator removal or
 * role change, visibility change, deletion). Matching connections re-resolve
 * their credentials and re-authorise at once; those that lost access close.
 * Never throws: the change it follows has already been made.
 */
export async function recheckLive(match: LiveMatch): Promise<void> {
  try {
    await recheck?.(match);
  } catch (err) {
    logger.warn({ error: String(err) }, 'live: recheck after an access change failed');
  }
}
