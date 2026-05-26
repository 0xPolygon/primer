/**
 * Pull a `title:` value out of YAML-ish frontmatter at the start of an MD
 * source slice. Strictly a UX prefill aid: gray-matter on the server is the
 * authoritative parser. Anything we can't handle returns null and the user
 * types the title themselves.
 *
 * Handles: bare values, single-quoted, double-quoted, CRLF line endings,
 * values with colons. Does not handle: multi-line values, anchors, aliases,
 * arrays, nested structures.
 */
export function extractFrontmatterTitle(input: string): string | null {
  // Normalize CRLF to LF for the scan; doesn't mutate the caller's source.
  const src = input.replace(/\r\n/g, '\n');

  if (!src.startsWith('---\n')) return null;

  const bodyStart = '---\n'.length;
  const closeIdx = src.indexOf('\n---', bodyStart);
  if (closeIdx === -1) return null;

  const block = src.slice(bodyStart, closeIdx);
  const lines = block.split('\n');

  for (const line of lines) {
    const m = /^title:\s*(.*)$/.exec(line);
    if (!m) continue;
    let raw = m[1].trim();
    if (raw.length === 0) return null;

    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      raw = raw.slice(1, -1);
    }

    return raw.length > 0 ? raw : null;
  }

  return null;
}
