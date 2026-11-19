import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RecordsSnapshot } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { versions, widgets } from '../db/schema.ts';
import { createLiveThread } from '../lib/liveThreads.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { readBundleFile } from '../live/bundle.ts';
import { createCheckpoint, restoreCheckpoint } from '../live/checkpoint.ts';
import { readBlocks } from '../live/editor.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from '../live/live.testlib.ts';
import { applyOps } from '../live/ops.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { draftWidget, publishWidget } from '../widgets/store.ts';
import { flushDataChanged } from './changed.ts';
import { recordsApi } from './store.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock', kind: 'person', viaUserId: null };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const CHART = `export default function render({ rows, tokens }) {
  return (
    <svg viewBox="0 0 300 120">
      <g data-anchor="bars">{rows.map((r, i) => <rect data-row={r.id} data-col="signups" x={10 + i * 40} y={110 - r.signups / 5} width="30" height={r.signups / 5} fill={tokens.accent1} />)}</g>
    </svg>
  );
}`;

/** A live document with a data table over `signups` after the intro paragraph. */
async function tableDoc(): Promise<{ documentId: string; blockId: string }> {
  const documentId = await createLiveDoc();
  await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
  const columns = JSON.stringify([{ key: 'week', label: 'Week', type: 'text' }, { key: 'signups', label: 'Signups', type: 'number' }]);
  const out = await applyOps(documentId, owner, {
    ops: [{ op: 'add', at: { tabId: 'main', blockId: 'intro' }, position: 'after', blocks: [{ json: { type: 'dataTable', props: { collection: 'signups', columns } } }] }],
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const blockId = await withLiveDoc(documentId, (doc) => readBlocks(doc, 'main').find((b) => b.type === 'dataTable')!.id);
  return { documentId, blockId };
}

describe('data tables', () => {
  it('a comment lands on a row', async () => {
    const { documentId, blockId } = await tableDoc();
    await recordsApi(owner, documentId).set({ collection: 'signups', scope: 'shared', recordId: 'w1', data: { week: 'W1', signups: 240 } });
    const notifier = new NoopNotifier();
    const target = { tabId: 'main', blockId };

    const row = await createLiveThread(notifier, owner, documentId, { anchor: { type: 'data-point', target, row: 'w1', column: '' }, body: 'Is W1 complete?' });
    expect(row.ok).toBe(true);
    const cell = await createLiveThread(notifier, owner, documentId, { anchor: { type: 'data-point', target, row: 'w1', column: 'signups' }, body: 'Source?' });
    expect(cell.ok).toBe(true);
    // Only rows that exist, columns the table names, and the block itself.
    for (const anchor of [
      { type: 'data-point', target, row: 'w9', column: '' },
      { type: 'data-point', target, row: 'w1', column: 'secret' },
      { type: 'data-point', target, row: '../../etc', column: '' },
      { type: 'data-point', target: { ...target, textId: 'x' }, row: 'w1', column: '' },
    ]) {
      expect(await createLiveThread(notifier, owner, documentId, { anchor, body: 'x' }), JSON.stringify(anchor)).toMatchObject({ ok: false });
    }
    await flushDataChanged();
  });

  it('a checkpoint freezes the records its tables and bound charts draw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-table-'));
    try {
      const storage = new FilesystemStorage(root);
      const { documentId } = await tableDoc();
      const records = recordsApi(owner, documentId);
      await records.set({ collection: 'signups', scope: 'shared', recordId: 'w1', data: { week: 'W1', signups: 240 } });
      await records.set({ collection: 'signups', scope: 'shared', recordId: 'w2', data: { week: 'W2', signups: 410 } });
      await records.set({ collection: 'mine', scope: 'personal', recordId: 'p', data: { note: 'private' } });
      await flushDataChanged();
      const draft = await draftWidget(owner, documentId, { source: CHART, collection: 'signups', afterBlockId: 'intro' });
      if (!draft.ok) throw new Error(JSON.stringify(draft.refusal));
      await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);

      // A write lands, and the checkpoint is taken before its chart redraw (the 2 s window).
      await records.update({ collection: 'signups', scope: 'shared', recordId: 'w2', data: { signups: 500 } });
      const checkpoint = await createCheckpoint(storage, documentId, owner, null);
      const [version] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      const bundle = version!.bundleKey!;

      const frozen = JSON.parse(dec(await readBundleFile(storage, bundle, 'records.json'))) as RecordsSnapshot;
      expect(Object.keys(frozen.collections)).toEqual(['signups']);
      expect(frozen.collections.signups!.map((r) => [r.recordId, r.data.signups])).toEqual([['w1', 240], ['w2', 500]]);
      // The table and the chart in static.html show the same rows.
      const html = dec(await readBundleFile(storage, bundle, 'static.html'));
      expect(html).toContain('<td>W2</td><td>500</td>');
      const kept = JSON.parse(dec(await readBundleFile(storage, bundle, `widgets/${draft.value.widgetId}.json`))) as { rows: unknown };
      expect(kept.rows).toEqual([{ id: 'w1', week: 'W1', signups: 240 }, { id: 'w2', week: 'W2', signups: 500 }]);
      expect(dec(await readBundleFile(storage, bundle, `widgets/${draft.value.widgetId}.light.svg`))).toContain('height="100"');

      // Live records move on; a restore brings the content back, and the chart draws live records again.
      await records.update({ collection: 'signups', scope: 'shared', recordId: 'w2', data: { signups: 100 } });
      await flushDataChanged();
      await restoreCheckpoint(storage, { documentId, bundleKey: bundle }, owner);
      const [row] = await db.select().from(widgets).where(eq(widgets.id, draft.value.widgetId));
      expect(row!.rows).toEqual([{ id: 'w1', week: 'W1', signups: 240 }, { id: 'w2', week: 'W2', signups: 100 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
