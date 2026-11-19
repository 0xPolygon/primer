import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrimerVersionStorage } from './versionStorage.ts';

afterEach(() => vi.unstubAllGlobals());

describe('version history', () => {
  it('a version from before the document went live opens in the version viewer', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({
        versions: [
          { id: 'v2', versionNumber: 2, versionNote: null, sizeBytes: 1, createdAt: '2026-11-19T00:00:00Z', bundled: true },
          { id: 'v1', versionNumber: 1, versionNote: null, sizeBytes: 1, createdAt: '2026-11-18T00:00:00Z', bundled: false },
        ],
      });
    });
    const opened: number[] = [];
    const storage = new PrimerVersionStorage('doc-1', (n) => opened.push(n));
    const listed = await storage.list(new AbortController().signal);
    expect(listed.ok && listed.value.snapshots.map((s) => s.id)).toEqual(['v2', 'v1']);

    const abort = new AbortController();
    void storage.getContent('v1', abort.signal).catch(() => undefined);
    abort.abort();
    expect(opened).toEqual([1]);
    expect(urls.some((u) => u.includes('/ydoc'))).toBe(false);
  });
});
