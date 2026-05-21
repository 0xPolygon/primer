import type { ReactNode } from 'react';
import type { MentionableUser } from '@primer/shared';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a plain-text comment body, wrapping each `@<displayName>` substring
 * (for users in the supplied directory whose IDs appear in `mentions`) with
 * a styled span. Returns a React fragment with mixed text + spans.
 *
 * Imperfect: if the body contains the same display name twice but only one
 * was the typeahead pick, both get highlighted. Acceptable for an internal
 * tool where names aren't ambiguous in practice.
 */
export function renderMentions(
  body: string,
  mentions: string[],
  users: ReadonlyArray<MentionableUser>,
): ReactNode {
  const names = mentions
    .map((id) => users.find((u) => u.id === id)?.displayName)
    .filter((n): n is string => typeof n === 'string')
    .sort((a, b) => b.length - a.length); // longest first so prefixes don't shadow
  if (names.length === 0) return body;
  const pattern = new RegExp(`@(?:${names.map(escapeRegex).join('|')})`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(
      <span
        key={`${m.index}-${m[0]}`}
        className="rounded-sm bg-yellow-50 dark:bg-amber-900/30 px-0.5 text-yellow-700 dark:text-yellow-300"
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return <>{out}</>;
}
