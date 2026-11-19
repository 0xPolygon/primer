import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { versions, widgets } from '../db/schema.ts';
import { readBundleFile } from '../live/bundle.ts';
import { createCheckpoint, restoreCheckpoint } from '../live/checkpoint.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from '../live/live.testlib.ts';
import { applyPlan } from '../live/pipeline.ts';
import { readBlocks } from '../live/editor.ts';
import { reachableFragments } from '../live/reach.ts';
import { labelEdit, readLabel } from './labels.ts';
import { draftWidget, getWidget, publishWidget, widgetImage } from './store.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock', kind: 'person', viaUserId: null };

const flow = (review: string, merge = 'Merge') => `export default function render({ tokens }) {
  return (
    <svg viewBox="0 0 400 80">
      <g data-anchor="step-review"><text data-text-id="review" x="20" y="40" fill={tokens.fg}>${review}</text></g>
      <g data-anchor="step-merge"><text data-text-id="merge" x="200" y="40" fill={tokens.fg}>${merge}</text></g>
    </svg>
  );
}`;

async function draftAndPublish(documentId: string, source: string, widgetId?: string) {
  const draft = await draftWidget(owner, documentId, { widgetId, source, afterBlockId: widgetId ? undefined : 'intro' });
  if (!draft.ok) throw new Error(JSON.stringify(draft.refusal));
  const published = await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
  if (!published.ok) throw new Error(JSON.stringify(published.refusal));
  return { draft: draft.value, published: published.value };
}

/** A person types into a label (as the overlay does, through the same fragment). */
async function personEdits(documentId: string, blockId: string, textId: string, text: string) {
  await applyPlan(documentId, { kind: 'person', actorId: owner.id, runId: null }, {
    onConflict: 'refuse',
    edits: [labelEdit({ tabId: 'main', blockId, textId }, text)],
  });
}

describe('widget drafts and publishes', () => {
  it('places the block, publishes, and seeds reachable label fragments', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro'), paragraph('outro', 'Outro')]);
    const { draft, published } = await draftAndPublish(documentId, flow('Review'));
    expect(draft.png.light.length).toBeGreaterThan(100);

    await withLiveDoc(documentId, (doc) => {
      const blocks = readBlocks(doc, 'main');
      expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'widget', 'paragraph']);
      expect(blocks[1]!.props).toEqual({ widgetId: draft.widgetId, hash: published.publishedHash, textIds: 'review merge' });
      expect(readLabel(doc, draft.blockId, 'review')).toBe('Review');
      expect(reachableFragments(doc)).toEqual(['document-store', `widget/${draft.blockId}/review`, `widget/${draft.blockId}/merge`]);
    });
  });

  it('a draft with errors never replaces the live widget', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const { draft, published } = await draftAndPublish(documentId, flow('Review'));

    const broken = await draftWidget(owner, documentId, { widgetId: draft.widgetId, source: flow('Review').replace('{tokens.fg}', '"#000"') });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.refusal.code).toBe('widget_invalid');
    expect(broken.refusal.details?.errors).toEqual([expect.objectContaining({ line: 4, message: 'Literal colour "#000" in `fill`.' })]);

    const [row] = await db.select().from(widgets).where(eq(widgets.id, draft.widgetId));
    expect(row!.publishedHash).toBe(published.publishedHash);
    expect(row!.draftErrors).not.toBeNull();
    // Publishing is refused while the draft has errors; the live SVG still serves.
    expect((await publishWidget(owner, draft.widgetId, draft.previewHash)).ok).toBe(false);
    const image = await widgetImage(owner, draft.widgetId, 'light', 'svg');
    expect(image.ok && 'svg' in image.value && image.value.svg).toContain('>Review</text>');
  });

  it('publish with a stale previewHash is refused', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const first = await draftWidget(owner, documentId, { source: flow('Review'), afterBlockId: 'intro' });
    if (!first.ok) throw new Error('draft failed');
    const second = await draftWidget(owner, documentId, { widgetId: first.value.widgetId, source: flow('Code review') });
    if (!second.ok) throw new Error('draft failed');

    const stale = await publishWidget(owner, first.value.widgetId, first.value.previewHash);
    expect(stale).toMatchObject({ ok: false, status: 409, refusal: { code: 'widget_invalid', details: { previewHash: second.value.previewHash } } });
    expect((await publishWidget(owner, first.value.widgetId, second.value.previewHash)).ok).toBe(true);
  });

  it('label edit survives republish when the text id is kept', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const { draft } = await draftAndPublish(documentId, flow('Review'));
    await personEdits(documentId, draft.blockId, 'review', 'Peer review');

    // The agent redraws: it keeps the review label, rewords the merge label.
    const redraw = await draftAndPublish(documentId, flow('Review', 'Ship it'), draft.widgetId);
    expect(redraw.draft.labels).toEqual([{ textId: 'review', status: 'carried', text: 'Peer review', agentText: 'Review' }]);
    const dto = await getWidget(owner, draft.widgetId);
    expect(dto.ok && dto.value.labels).toEqual({ review: 'Peer review', merge: 'Ship it' });

    // Both changed the same label: the person's words stay and the agent is told.
    const clash = await draftAndPublish(documentId, flow('Approval', 'Ship it'), draft.widgetId);
    expect(clash.published.labels).toEqual([{ textId: 'review', status: 'kept', text: 'Peer review', agentText: 'Approval' }]);
    const image = await widgetImage(owner, draft.widgetId, 'dark', 'svg');
    expect(image.ok && 'svg' in image.value && image.value.svg).toContain('>Peer review</text>');
  });

  it('a stranger cannot draft', async () => {
    const stranger: AuthUser = { ...owner, id: 'someone-else' };
    const documentId = await createLiveDoc();
    expect(await draftWidget(stranger, documentId, { source: flow('Review') })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('widgets in checkpoints', () => {
  it('a checkpoint keeps the widget as it looked, and restore brings back its labels and publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-widget-bundle-'));
    const storage = new FilesystemStorage(root);
    try {
      const documentId = await createLiveDoc();
      await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
      const { draft } = await draftAndPublish(documentId, flow('Review'));
      await personEdits(documentId, draft.blockId, 'review', 'Peer review');
      const checkpoint = await createCheckpoint(storage, documentId, owner, null);
      const [version] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      const file = async (name: string) => new TextDecoder().decode(await readBundleFile(storage, version!.bundleKey!, name));

      expect(await file(`widgets/${draft.widgetId}.dark.svg`)).toContain('>Peer review</text>');
      const staticHtml = await file('static.html');
      expect(staticHtml).toContain('class="primer-widget-light"');
      expect(staticHtml).toContain('>Peer review</text>');
      expect(await file('export.md')).toContain(`\`\`\`primer-widget\n${draft.widgetId}\n\`\`\``);

      // Later: the person edits again and the agent redraws; restore brings both back.
      await personEdits(documentId, draft.blockId, 'review', 'Second look');
      await draftAndPublish(documentId, flow('Review', 'Ship it'), draft.widgetId);
      await restoreCheckpoint(storage, { documentId, bundleKey: version!.bundleKey! }, owner);
      const dto = await getWidget(owner, draft.widgetId);
      expect(dto.ok && dto.value.labels).toEqual({ review: 'Peer review', merge: 'Merge' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
