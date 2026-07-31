import type { MentionableUser } from '@polygonlabs/primer-api-types';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given a textarea body, the set of user IDs the typeahead has selected,
 * and the directory of known users, return the final submit-ready array
 * of user IDs whose `@<displayName>` substring still appears in the body.
 * This is the "delete by re-typing" safety net for the textarea-based
 * mention UX.
 */
export function reconcileMentions(
  body: string,
  selected: ReadonlySet<string>,
  users: ReadonlyArray<MentionableUser>,
): string[] {
  const out: string[] = [];
  for (const id of selected) {
    const u = users.find((x) => x.id === id);
    if (!u) continue;
    const pattern = new RegExp(`@${escapeRegex(u.displayName)}(?:\\b|\\s|$)`);
    if (pattern.test(body)) out.push(id);
  }
  return out;
}
