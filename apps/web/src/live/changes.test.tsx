// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CatchUpDTO, Target } from '@polygonlabs/primer-api-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: string[] = [];
const catchUp: CatchUpDTO = {
  documentId: 'd1', title: 'Plan', since: { at: '2026-11-19T10:00:00.000Z', docVersion: 4 }, until: { at: '2026-11-19T12:00:00.000Z', docVersion: 9 },
  people: [{ id: 'u-ada', displayName: 'Ada', kind: 'person', edits: 2, comments: 1, resolved: 0, decisions: 0, suggestions: 0, tasks: 0 }],
  changedBlocks: [{ target: { tabId: 'main', blockId: 'b2' }, type: 'paragraph', version: 'v', markdown: 'Ship Monday', depth: 0, parentId: null }],
  moreChangedBlocks: 0, deletedBlockIds: [],
  threads: [{ threadId: 't1', event: 'started', by: 'u-ada', at: '2026-11-19T11:00:00.000Z', quote: 'Monday', excerpt: 'Sure?' }],
  decisions: [], suggestions: [], tasks: [], versions: [],
};
vi.mock('../lib/fetch.ts', () => ({
  api: async (path: string) => {
    calls.push(path);
    if (path.endsWith('/versions')) {
      return new Response(JSON.stringify({ versions: [{ id: 'v2', versionNumber: 2, versionNote: null, sizeBytes: 1, createdAt: '', bundled: true, docVersion: 7 }] }));
    }
    if (path.includes('/live?')) return new Response(JSON.stringify({ blocks: [{ target: { tabId: 'main', blockId: 'b3' } }] }));
    return new Response(JSON.stringify(catchUp));
  },
}));

async function render(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, root };
}

describe('change highlights', () => {
  it('blocks edited after the checkpoint are highlighted', async () => {
    const { ChangeHighlights, useCheckpointChanges } = await import('./changes.tsx');
    function Probe() {
      const ids = useCheckpointChanges('d1', 'main', true);
      return ids ? createElement(ChangeHighlights, { tone: 'checkpoint', blockIds: ids }) : null;
    }
    const { host, root } = await render(createElement(Probe));
    expect(calls).toContain('/api/documents/d1/live?format=json&tabId=main&since=7');
    const css = host.querySelector('style[data-change-highlights="checkpoint"]')!.textContent!;
    expect(css).toContain('.bn-block-outer[data-id="b3"]');
    await act(async () => root.unmount());
  });

  it('an id that is not a plain block id never reaches the stylesheet', async () => {
    const { ChangeHighlights } = await import('./changes.tsx');
    const { host, root } = await render(createElement(ChangeHighlights, { tone: 'catchup', blockIds: ['ok-1', '"] {} body { display:none } ["'] }));
    const css = host.querySelector('style')!.textContent!;
    expect(css).toContain('data-id="ok-1"');
    expect(css).not.toContain('display:none');
    await act(async () => root.unmount());
  });

  it('catch-up shows who changed what since the last visit and highlights it until dismissed', async () => {
    const { CatchUpPanel, ChangeHighlights } = await import('./changes.tsx');
    function Host() {
      const [blocks, setBlocks] = useState<Target[]>([]);
      return createElement(
        'div',
        null,
        createElement(CatchUpPanel, { documentId: 'd1', since: catchUp.since, onBlocks: setBlocks }),
        createElement(ChangeHighlights, { tone: 'catchup', blockIds: blocks.map((b) => b.blockId) }),
      );
    }
    const { host, root } = await render(createElement(Host));
    expect(calls).toContain('/api/documents/d1/catchup?since=2026-11-19T10%3A00%3A00.000Z&sinceVersion=4');
    expect(host.textContent).toContain('Ada: edits: 2, comments: 1');
    expect(host.textContent).toContain('Ada commented on “Monday”');
    expect(host.querySelector('style')!.textContent).toContain('data-id="b2"');
    const dismiss = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
    await act(async () => dismiss.click());
    expect(host.querySelector('[data-catch-up]')).toBeNull();
    expect(host.querySelector('style')).toBeNull();
    await act(async () => root.unmount());
  });
});
