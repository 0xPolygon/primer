// Host side of page text (M6.3): which pids people may edit in the overlay.
//
// The bridge reports every stamped element's DOM text once, after the page's
// own scripts ran and before the host sets any text. Text a script drew or
// rewrote no longer equals the source text at the pid's span, so that pid is
// read-only: people edit only what the page shows as authored.

/** Whitespace-normalised text, the same rule as the server's `pageText`
 *  (apps/api/src/page/stamp.ts): each line's whitespace runs are one space and
 *  its ends are trimmed. */
export function normalizePageText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .join('\n');
}

/**
 * The pids people may edit: stamped pids the bridge reported with their
 * source text. Pids a script redrew, and pids missing from the page (the
 * sanitizer dropped their element, or a script removed it), are read-only.
 */
export function editablePids(
  stamped: Record<string, string>,
  reported: { pid: string; text: string }[],
): Set<string> {
  const editable = new Set<string>();
  const seen = new Set<string>();
  for (const { pid, text } of reported) {
    if (seen.has(pid)) {
      // A script cloned a stamped element: neither copy is safe to edit.
      editable.delete(pid);
      continue;
    }
    seen.add(pid);
    const source = stamped[pid];
    if (source !== undefined && normalizePageText(text) === normalizePageText(source)) editable.add(pid);
  }
  return editable;
}
