import { describe, it, expect } from 'vitest';
import { nextLatch, resolveViewedVersion, composerPendingFrom, type VersionLatch } from './viewedVersion.ts';

const v = (n: number) => ({ id: `id-${n}`, versionNumber: n });

/** One render of the document page's version resolution: what the page
 *  shows and which version a new thread/reply posts to (the same id). */
function render(params: {
  prev: VersionLatch | null;
  locationKey: string;
  requestedNumber: number | undefined;
  versions: { id: string; versionNumber: number }[];
}) {
  const latch = nextLatch(params);
  const viewed = resolveViewedVersion({
    versions: params.versions,
    requestedNumber: params.requestedNumber,
    latch,
  });
  return { latch, viewed, postTargetId: viewed?.id };
}

describe('viewed version on /d/:docId (no version in the URL)', () => {
  it('a version-list refresh never changes the viewed version or the version a post targets', () => {
    const first = render({ prev: null, locationKey: 'k1', requestedNumber: undefined, versions: [v(4), v(3)] });
    expect(first.viewed?.versionNumber).toBe(4);
    expect(first.postTargetId).toBe('id-4');

    // A poll returns a list where v5 now exists. Same navigation (same key).
    const afterPoll = render({
      prev: first.latch,
      locationKey: 'k1',
      requestedNumber: undefined,
      versions: [v(5), v(4), v(3)],
    });
    expect(afterPoll.viewed?.versionNumber).toBe(4);
    expect(afterPoll.postTargetId).toBe('id-4');
  });

  it('re-resolves to the newest version only when the user navigates (new location key)', () => {
    const first = render({ prev: null, locationKey: 'k1', requestedNumber: undefined, versions: [v(4)] });
    const navigated = render({
      prev: first.latch,
      locationKey: 'k2',
      requestedNumber: undefined,
      versions: [v(5), v(4)],
    });
    expect(navigated.viewed?.versionNumber).toBe(5);
    expect(navigated.postTargetId).toBe('id-5');
  });

  it('waits for the list before latching, then latches the first loaded latest', () => {
    const loading = render({ prev: null, locationKey: 'k1', requestedNumber: undefined, versions: [] });
    expect(loading.latch).toBeNull();
    expect(loading.viewed).toBeUndefined();
    const loaded = render({ prev: loading.latch, locationKey: 'k1', requestedNumber: undefined, versions: [v(2), v(1)] });
    expect(loaded.viewed?.versionNumber).toBe(2);
  });

  it('falls back to the newest version if the latched one disappears from the list', () => {
    const first = render({ prev: null, locationKey: 'k1', requestedNumber: undefined, versions: [v(3), v(2)] });
    const gone = render({ prev: first.latch, locationKey: 'k1', requestedNumber: undefined, versions: [v(2)] });
    expect(gone.viewed?.versionNumber).toBe(2);
  });
});

describe('viewed version on /d/:docId/v/:n', () => {
  it('always shows the requested version, whatever the list refresh returns', () => {
    const r = render({ prev: null, locationKey: 'k1', requestedNumber: 3, versions: [v(5), v(4), v(3)] });
    expect(r.viewed?.versionNumber).toBe(3);
    expect(r.postTargetId).toBe('id-3');
  });

  it('is undefined for a version number that does not exist', () => {
    const r = render({ prev: null, locationKey: 'k1', requestedNumber: 9, versions: [v(2)] });
    expect(r.viewed).toBeUndefined();
  });
});

describe('composerPendingFrom (a poll lands mid-compose)', () => {
  it('keeps the open composer and its anchor; it takes no "is latest" input that could close it', () => {
    expect(composerPendingFrom({ pendingSelection: { anchor: 'sel' }, pendingPick: null })).toEqual({
      anchor: 'sel',
      origin: 'selection',
    });
    expect(composerPendingFrom({ pendingSelection: null, pendingPick: { anchor: 'pick' } })).toEqual({
      anchor: 'pick',
      origin: 'pick',
    });
  });

  it('has nothing to show when no anchor is pending', () => {
    expect(composerPendingFrom({ pendingSelection: null, pendingPick: null })).toBeNull();
  });
});
