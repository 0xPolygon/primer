import type { LibraryDocument } from '@polygonlabs/primer-api-types';

export const FOLDER_UNCATEGORIZED = '' as const;

export type Chip = 'all' | 'mine' | 'shared' | 'templates' | 'deleted';
export type SortKey = 'activity' | 'uploaded' | 'title-asc' | 'title-desc';

export interface FilterOpts {
  folderId: string | null;   // null = All; FOLDER_UNCATEGORIZED = Uncategorized; other = folder id
  chip: Chip;
  q: string;
  sortKey: SortKey;
}

const MAX_NAME = 60;

export function normalizeFolderNameClient(raw: string):
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too-long' } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_NAME) return { ok: false, reason: 'too-long' };
  return { ok: true, name: trimmed };
}

function matchesFolder(d: LibraryDocument, folderId: string | null): boolean {
  if (folderId === null) return true;
  if (folderId === FOLDER_UNCATEGORIZED) return d.folderId === null;
  return d.folderId === folderId;
}

function matchesChip(d: LibraryDocument, chip: Chip): boolean {
  switch (chip) {
    case 'all':
      // The API already scopes the feed to the caller's accessed library
      // (created, collaborator, or org docs they've opened), so 'all' shows
      // everything returned.
      return true;
    case 'mine':
      // Docs the caller created or is an explicit collaborator on.
      return d.ownership === 'mine' || d.ownership === 'collaborator';
    case 'shared':
      // Org docs shared with the caller via link (opened, not owned/collab).
      return d.ownership === 'org';
    case 'templates':
      // Documents marked as templates ("New from template" forks one).
      return d.isTemplate;
    case 'deleted':
      // 'deleted' chip is handled by swapping data source in the page,
      // not by filtering LibraryDocument[]. This branch should never run
      // on live docs — return true so callers who misuse it still see docs.
      return true;
  }
}

function matchesQuery(d: LibraryDocument, q: string): boolean {
  if (q.length === 0) return true;
  const needle = q.toLowerCase();
  if (d.title.toLowerCase().includes(needle)) return true;
  if (d.description && d.description.toLowerCase().includes(needle)) return true;
  return false;
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const comparators: Record<SortKey, (a: LibraryDocument, b: LibraryDocument) => number> = {
  activity: (a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0),
  uploaded: (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
  'title-asc': (a, b) => titleCollator.compare(a.title, b.title),
  'title-desc': (a, b) => titleCollator.compare(b.title, a.title),
};

export function filterAndSort(docs: LibraryDocument[], opts: FilterOpts): LibraryDocument[] {
  return docs
    .filter((d) => matchesFolder(d, opts.folderId))
    .filter((d) => matchesChip(d, opts.chip))
    .filter((d) => matchesQuery(d, opts.q))
    .sort(comparators[opts.sortKey]);
}

export function hashHue(id: string): number {
  // FNV-1a 32-bit, deterministic, no library needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}
