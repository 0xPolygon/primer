// @vitest-environment jsdom
//
// The real v1.js, run in jsdom as a share serves it: top level, no host, the
// checkpoint's records frozen in the page (records/page.ts withFrozenRecords).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordsSnapshot } from '@polygonlabs/primer-api-types';
import { withFrozenRecords } from '../records/page.ts';

const src = readFileSync(join(process.cwd(), 'src/companion/v1.js'), 'utf8');

type Records = Record<string, (args: unknown) => Promise<unknown>>;

describe('frozen records in a checkpoint page', () => {
  it('reads answer from the snapshot and writes are refused', async () => {
    const snapshot: RecordsSnapshot = {
      capturedAt: '2026-11-20T00:00:00.000Z',
      toChangeId: 7,
      collections: {
        votes: [
          { recordId: 'a', data: { option: 'eu', n: 2 }, version: 1, updatedAt: '2026-11-20T00:00:00.000Z', writtenBy: 'Bea' },
          { recordId: 'b', data: { option: 'us', n: 5 }, version: 3, updatedAt: '2026-11-20T00:00:00.000Z', writtenBy: 'Ann' },
          { recordId: 'c', data: { option: 'eu', n: 1, note: '</script>' }, version: 1, updatedAt: '2026-11-20T00:00:00.000Z', writtenBy: 'Cy' },
        ],
      },
    };
    const page = '<html><head><meta name="primer-records" content="read"></head><body></body></html>';
    document.documentElement.innerHTML = new DOMParser().parseFromString(withFrozenRecords(page, snapshot), 'text/html').documentElement.innerHTML;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    new Function(src)();
    const records = (window as unknown as { primer: { records: Records } }).primer.records;

    const list = (await records.list!({ collection: 'votes', scope: 'shared', limit: 2 })) as { records: { recordId: string; data: Record<string, unknown> }[]; nextCursor: string };
    expect(list.records.map((r) => r.recordId)).toEqual(['a', 'b']);
    const next = (await records.list!({ collection: 'votes', scope: 'shared', cursor: list.nextCursor })) as { records: { data: { note: string } }[]; nextCursor: null };
    expect(next).toMatchObject({ records: [{ data: { note: '</script>' } }], nextCursor: null });

    const query = (await records.query!({ collection: 'votes', scope: 'shared', where: { option: 'eu' }, orderBy: { key: 'n', dir: 'desc' } })) as { records: { recordId: string }[] };
    expect(query.records.map((r) => r.recordId)).toEqual(['a', 'c']);
    expect(await records.get!({ collection: 'votes', scope: 'shared', recordId: 'b' })).toMatchObject({ record: { data: { option: 'us' }, writtenBy: 'Ann' } });
    // Personal records are never frozen.
    expect(await records.list!({ collection: 'votes', scope: 'personal' })).toEqual({ records: [], nextCursor: null });
    await expect(records.set!({ collection: 'votes', scope: 'shared', recordId: 'd', data: {} })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
