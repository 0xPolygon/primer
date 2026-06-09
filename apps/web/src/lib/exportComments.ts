import type { ThreadDTO } from '@primer/shared';

interface DocInfo {
  title: string;
}

interface VersionInfo {
  versionNumber: number;
}

/**
 * Format a version's threads as Markdown for Claude (or any human reader)
 * to consume. Tombstoned comments are excluded. Threads with all comments
 * tombstoned are omitted entirely. Threads are sorted by creation time
 * ascending. Each thread header carries its status (active/resolved) so
 * downstream tooling can default to active-only.
 */
export function formatThreadsAsMarkdown(
  doc: DocInfo,
  version: VersionInfo,
  threads: ThreadDTO[],
  now: Date = new Date(),
): string {
  const aliveThreads = threads
    .map((t) => ({ ...t, comments: t.comments.filter((c) => c.deletedAt === null) }))
    .filter((t) => t.comments.length > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const openCount = aliveThreads.filter((t) => t.resolvedAt === null).length;
  const commentCount = aliveThreads.reduce((acc, t) => acc + t.comments.length, 0);
  const exportDate = now.toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`# Comments on "${doc.title}" (v${version.versionNumber})`);
  lines.push('');
  lines.push(
    `Exported ${exportDate} · ${openCount} open thread${openCount === 1 ? '' : 's'} · ${commentCount} comment${commentCount === 1 ? '' : 's'}`,
  );
  lines.push('');

  aliveThreads.forEach((t, i) => {
    lines.push('---');
    lines.push('');
    const status = t.resolvedAt !== null ? 'resolved' : 'active';
    lines.push(`## Thread ${i + 1} — ${status}`);

    if (t.anchor.type === 'text-range') {
      lines.push(`**Anchored on:** "${t.anchor.selectorText}"`);
      // Prefix + selection + suffix gives Claude enough surrounding text to
      // disambiguate the same phrase appearing multiple times. New
      // position-based anchors don't carry surrounding-text fields — their
      // position alone is unique — so the Context line is naturally omitted
      // for them when prefix/suffix are absent.
      const prefix = t.anchor.prefix ?? '';
      const suffix = t.anchor.suffix ?? '';
      const context = `${prefix}${t.anchor.selectorText}${suffix}`.trim();
      if (context.length > 0 && context !== t.anchor.selectorText) {
        lines.push(`**Context:** "…${context}…"`);
      }
    } else {
      const inner = t.anchor.innerText;
      if (inner && inner.length > 0) {
        lines.push(`**Anchored on element:** "${inner}"`);
      } else {
        lines.push(`**Anchored on element:** \`${t.anchor.path}\``);
      }
    }
    lines.push('');

    t.comments.forEach((c) => {
      const editedMark = c.updatedAt ? ' (edited)' : '';
      lines.push(`> **${c.authorDisplayName}** · ${c.createdAt}${editedMark}`);
      c.body.split('\n').forEach((bodyLine) => {
        lines.push(`> ${bodyLine}`);
      });
      lines.push('');
    });
  });

  return lines.join('\n');
}

/** Sluggify the doc title for a filesystem-safe download filename. */
export function commentsFilename(doc: DocInfo, version: VersionInfo): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}-v${version.versionNumber}-comments.md`;
}

/** Sluggify the doc title for a filesystem-safe HTML download filename.
 *  Uses the same slug rule as commentsFilename — diverges only in the
 *  suffix. */
export function htmlFilename(doc: DocInfo, version: VersionInfo): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}-v${version.versionNumber}.html`;
}
