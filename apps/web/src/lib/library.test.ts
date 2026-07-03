import { describe, it, expect } from 'vitest';
import { filterAndSort, hashHue, normalizeFolderNameClient, FOLDER_UNCATEGORIZED } from './library';
import type { LibraryDocument } from '@primer/shared';

function doc(partial: Partial<LibraryDocument>): LibraryDocument {
  return {
    id: 'd1',
    title: 'Doc',
    description: null,
    uploaderId: 'u1',
    uploaderDisplayName: 'User One',
    visibility: 'org',
    ownership: 'mine',
    threadCount: 0,
    activeThreadCount: 0,
    lastActivityAt: '2026-07-01T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
    folderId: null,
    ...partial,
  };
}

describe('filterAndSort', () => {
  it('folderId=null shows all docs', () => {
    const docs = [doc({ id: 'a', folderId: null }), doc({ id: 'b', folderId: 'f1' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('folderId=FOLDER_UNCATEGORIZED shows only unfiled docs', () => {
    const docs = [doc({ id: 'a', folderId: null }), doc({ id: 'b', folderId: 'f1' })];
    const out = filterAndSort(docs, { folderId: FOLDER_UNCATEGORIZED, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('folderId=<real> shows only docs in that folder', () => {
    const docs = [doc({ id: 'a', folderId: 'f1' }), doc({ id: 'b', folderId: 'f2' }), doc({ id: 'c', folderId: null })];
    const out = filterAndSort(docs, { folderId: 'f1', chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('chip=mine keeps ownership==="mine"', () => {
    const docs = [doc({ id: 'a', ownership: 'mine' }), doc({ id: 'b', ownership: 'org' }), doc({ id: 'c', ownership: 'collaborator' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'mine', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('chip=shared keeps ownership org OR collaborator', () => {
    const docs = [doc({ id: 'a', ownership: 'mine' }), doc({ id: 'b', ownership: 'org' }), doc({ id: 'c', ownership: 'collaborator' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'shared', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id).sort()).toEqual(['b', 'c']);
  });

  it('q matches title case-insensitively', () => {
    const docs = [doc({ id: 'a', title: 'Onboarding' }), doc({ id: 'b', title: 'ZK research' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: 'onboard', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('q matches description case-insensitively', () => {
    const docs = [doc({ id: 'a', title: 'X', description: 'about onboarding' }), doc({ id: 'b', title: 'Y', description: null })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: 'ONBOARD', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('sortKey=activity is descending by lastActivityAt', () => {
    const docs = [
      doc({ id: 'a', lastActivityAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'b', lastActivityAt: '2026-07-03T00:00:00Z' }),
      doc({ id: 'c', lastActivityAt: '2026-07-02T00:00:00Z' }),
    ];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('sortKey=uploaded is descending by createdAt', () => {
    const docs = [
      doc({ id: 'a', createdAt: '2026-07-01T00:00:00Z' }),
      doc({ id: 'b', createdAt: '2026-07-03T00:00:00Z' }),
    ];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'uploaded' });
    expect(out.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('sortKey=title-asc is locale-aware, case-insensitive', () => {
    const docs = [doc({ id: 'a', title: 'zebra' }), doc({ id: 'b', title: 'Apple' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'title-asc' });
    expect(out.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('sortKey=title-desc is the reverse of title-asc', () => {
    const docs = [doc({ id: 'a', title: 'zebra' }), doc({ id: 'b', title: 'Apple' })];
    const out = filterAndSort(docs, { folderId: null, chip: 'all', q: '', sortKey: 'title-desc' });
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('intersection: folder AND chip AND q all narrow together', () => {
    const docs = [
      doc({ id: 'a', folderId: 'f1', ownership: 'mine', title: 'Onboarding' }),
      doc({ id: 'b', folderId: 'f1', ownership: 'org', title: 'Onboarding' }),
      doc({ id: 'c', folderId: 'f2', ownership: 'mine', title: 'Onboarding' }),
      doc({ id: 'd', folderId: 'f1', ownership: 'mine', title: 'Other' }),
    ];
    const out = filterAndSort(docs, { folderId: 'f1', chip: 'mine', q: 'onboard', sortKey: 'activity' });
    expect(out.map((d) => d.id)).toEqual(['a']);
  });
});

describe('hashHue', () => {
  it('is deterministic for a given id', () => {
    expect(hashHue('doc-123')).toBe(hashHue('doc-123'));
  });
  it('produces a value in [0, 360)', () => {
    for (const id of ['a', 'bbbb', 'x'.repeat(50), '0000-0000-0000']) {
      const h = hashHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  it('gives different hues for different ids (spot check)', () => {
    expect(hashHue('a')).not.toBe(hashHue('z'));
  });
});

describe('normalizeFolderNameClient', () => {
  it('trims and accepts', () => {
    expect(normalizeFolderNameClient('  Research  ')).toEqual({ ok: true, name: 'Research' });
  });
  it('rejects empty', () => {
    expect(normalizeFolderNameClient('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeFolderNameClient('')).toEqual({ ok: false, reason: 'empty' });
  });
  it('rejects too long', () => {
    expect(normalizeFolderNameClient('x'.repeat(61))).toEqual({ ok: false, reason: 'too-long' });
  });
});
