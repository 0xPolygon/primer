export const MAX_MENTIONS = 25;

export type ValidationResult =
  | { ok: true; mentions: string[] }
  | { ok: false; error: 'invalid_mention' | 'too_many_mentions'; message: string };

/**
 * Cleans and validates a `mentions` array submitted with a comment write:
 *   - Tolerates undefined → returns [].
 *   - Rejects non-array input as 'invalid_mention'.
 *   - Rejects input over MAX_MENTIONS items (counted BEFORE dedup/self-removal
 *     so a request that submits 26 distinct ids is rejected even if 25 of them
 *     happen to be unique after cleaning).
 *   - Rejects unknown user IDs as 'invalid_mention'.
 *   - Silently removes the actor's own id and de-duplicates.
 */
export function validateAndCleanMentions(
  input: string[] | undefined,
  actorUserId: string,
  knownUserIds: ReadonlySet<string>,
): ValidationResult {
  if (input === undefined) return { ok: true, mentions: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: 'invalid_mention', message: 'mentions must be an array' };
  }
  if (input.length > MAX_MENTIONS) {
    return {
      ok: false,
      error: 'too_many_mentions',
      message: `mentions must be ≤ ${MAX_MENTIONS}`,
    };
  }
  const seen = new Set<string>();
  for (const id of input) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'invalid_mention', message: 'mention ids must be non-empty strings' };
    }
    if (!knownUserIds.has(id)) {
      return { ok: false, error: 'invalid_mention', message: `unknown user id: ${id}` };
    }
    if (id !== actorUserId) seen.add(id);
  }
  return { ok: true, mentions: [...seen] };
}
