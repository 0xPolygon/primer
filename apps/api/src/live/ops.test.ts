import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { PartialBlock } from '@blocknote/core';
import type { Reconciliation } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { threads, users } from '../db/schema.ts';
import { serverEditor } from './editor.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';
import { applyOps } from './ops.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { applyPlan } from './pipeline.ts';
import { getLiveDoc } from './read.ts';

const main = (blockId: string) => ({ tabId: 'main', blockId });

export async function makeAgent(via = 'mock-user-1'): Promise<AuthUser> {
  const id = `agent_${uuidv7()}`;
  await db.insert(users).values({ id, email: '', displayName: 'Helper', kind: 'agent', viaUserId: via });
  return { id, email: '', displayName: 'Helper', kind: 'agent', viaUserId: via };
}

export async function versions(documentId: string, agent: AuthUser): Promise<Record<string, string>> {
  const out = await getLiveDoc(documentId, agent, { format: 'json' });
  if (!out.ok) throw new Error(out.refusal.message);
  return Object.fromEntries(out.value.blocks.map((b) => [b.target.blockId, b.version]));
}

export async function markdownOf(documentId: string, agent: AuthUser): Promise<string[]> {
  const out = await getLiveDoc(documentId, agent, { format: 'markdown' });
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value.blocks.map((b) => b.markdown!);
}

export async function ops(documentId: string, agent: AuthUser, req: Record<string, unknown>): Promise<Reconciliation> {
  const out = await applyOps(documentId, agent, { baseVersion: 0, ...req });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value;
}

/** Puts an open thread's comment mark on `quote` in block `blockId`. */
export async function comment(documentId: string, blockId: string, quote: string, opts: { resolved?: boolean } = {}): Promise<string> {
  const threadId = uuidv7();
  await db.insert(threads).values({
    id: threadId,
    documentId,
    versionId: null,
    anchor: { type: 'prose', target: main(blockId), quote },
    resolvedAt: opts.resolved ? new Date() : null,
  });
  await applyPlan(documentId, SYSTEM_ORIGIN, {
    onConflict: 'refuse',
    edits: [
      {
        target: main(blockId),
        inverse: false,
        build: (tr, at) => {
          const from = at!.pos + 2 + at!.node.firstChild!.textContent.indexOf(quote);
          tr.addMark(from, from + quote.length, serverEditor().editor.pmSchema.marks.comment!.create({ threadId }));
        },
      },
    ],
  });
  return threadId;
}

async function storedJson(documentId: string): Promise<string> {
  return withLiveDoc(documentId, (doc) => JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('document-store'))));
}

describe('applyOps', () => {
  it('stale target conflicts, unrelated ops apply', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    const v = await versions(id, agent);
    // A person edits block a after the agent read it.
    await ops(id, agent, { ops: [{ op: 'update', target: main('a'), block: 'Alpha, by a person', expectVersion: v.a }] });

    const result = await ops(id, agent, {
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha, by the agent', expectVersion: v.a },
        { op: 'update', target: main('b'), block: 'Beta, by the agent', expectVersion: v.b },
      ],
    });

    expect(result.outcomes.map((o) => o.status)).toEqual(['conflict', 'applied']);
    expect(result.outcomes[0]!.refusal).toMatchObject({ code: 'target_changed' });
    expect(result.outcomes[1]!.blocks![0]).toMatchObject({ target: main('b'), markdown: 'Beta, by the agent' });
    expect(await markdownOf(id, agent)).toEqual(['Alpha, by a person', 'Beta, by the agent']);
  });

  it('invalid op rejects the whole batch with indexed fixes', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const v = await versions(id, agent);

    const out = await applyOps(id, agent, {
      baseVersion: 0,
      ops: [
        { op: 'update', target: main('a'), block: 'fine', expectVersion: v.a },
        { op: 'delete', target: main('a') },
        { op: 'add', at: main('a'), position: 'sideways', blocks: ['x'] },
      ],
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(400);
    expect(out.errors!.map((e) => e.index)).toEqual([1, 2]);
    expect(out.errors!.every((e) => e.refusal.code === 'invalid_op' && e.refusal.fix.length > 0)).toBe(true);
    expect(await markdownOf(id, agent)).toEqual(['Alpha']);
  });

  it('agent updates a coloured, commented paragraph via Markdown and keeps colour and comment mark', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [
      {
        id: 'p',
        type: 'paragraph',
        props: { textColor: 'red' },
        content: [
          { type: 'text', text: 'The quick ', styles: {} },
          { type: 'text', text: 'brown', styles: { backgroundColor: 'yellow', underline: true } },
          { type: 'text', text: ' fox jumps.', styles: {} },
        ],
      } as PartialBlock,
    ]);
    const threadId = await comment(id, 'p', 'quick');
    const v = await versions(id, agent);

    const result = await ops(id, agent, {
      ops: [{ op: 'update', target: main('p'), block: 'The quick **brown** fox leaps.', expectVersion: v.p }],
    });

    expect(result.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(result.outcomes[0]!.note).toBeUndefined();
    const stored = JSON.parse(await storedJson(id));
    const para = stored.content[0].content[0].content[0];
    expect(para.attrs.textColor).toBe('red');
    const texts = para.content as { text: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }[];
    expect(texts.map((t) => t.text).join('')).toBe('The quick brown fox leaps.');
    const quick = texts.find((t) => t.text.includes('quick'))!;
    expect(quick.marks?.some((m) => m.type === 'comment' && m.attrs?.threadId === threadId)).toBe(true);
    const brown = texts.find((t) => t.text === 'brown')!;
    expect(brown.marks!.map((m) => m.type).sort()).toEqual(['backgroundColor', 'bold', 'underline']);
  });

  it('link text edit keeps the href; href edit replaces the link', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [
      { id: 'p', type: 'paragraph', content: [{ type: 'link', href: 'https://a.example', content: 'old words' }, ' after'] } as PartialBlock,
    ]);
    let v = await versions(id, agent);

    await ops(id, agent, { ops: [{ op: 'update', target: main('p'), block: '[new words](https://a.example) after', expectVersion: v.p }] });
    let json = await storedJson(id);
    expect(json).toContain('"text":"new words"');
    expect(json).toContain('"href":"https://a.example"');

    v = await versions(id, agent);
    await ops(id, agent, { ops: [{ op: 'update', target: main('p'), block: '[new words](https://b.example) after', expectVersion: v.p }] });
    json = await storedJson(id);
    expect(json).toContain('"href":"https://b.example"');
    expect(json).not.toContain('https://a.example');
  });

  it('hard break and chip positions survive a text edit', async () => {
    // Primer's schema has no inline chips yet (mentions, dates); hard breaks
    // are the atoms the rebase anchors on, and chips take the same path.
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [{ id: 'p', type: 'paragraph', content: 'first line\nsecond line' } as PartialBlock]);
    const threadId = await comment(id, 'p', 'second');
    const v = await versions(id, agent);

    await ops(id, agent, { ops: [{ op: 'update', target: main('p'), block: 'first line edited  \nsecond line', expectVersion: v.p }] });

    const para = JSON.parse(await storedJson(id)).content[0].content[0].content[0];
    expect(para.content.map((n: { type: string; text?: string }) => n.type === 'hardBreak' ? '|' : n.text).join('')).toBe(
      'first line edited|second line',
    );
    expect(JSON.stringify(para)).toContain(threadId);
  });

  it('replaceRange swaps three blocks and refuses if one changed', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'A'), paragraph('b', 'B'), paragraph('c', 'C'), paragraph('d', 'D'), paragraph('e', 'E')]);
    const v = await versions(id, agent);
    const range = { b: v.b!, c: v.c!, d: v.d! };

    const ok = await ops(id, agent, { ops: [{ op: 'replaceRange', from: main('b'), to: main('d'), blocks: ['One\n\nTwo'], expectVersions: range }] });
    expect(ok.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(await markdownOf(id, agent)).toEqual(['A', 'One', 'Two', 'E']);

    // A second range, where a person changed the middle block meanwhile.
    await seedBlocks(id, [paragraph('a', 'A'), paragraph('b', 'B'), paragraph('c', 'C'), paragraph('d', 'D')]);
    const w = await versions(id, agent);
    await ops(id, agent, { ops: [{ op: 'update', target: main('c'), block: 'C changed', expectVersion: w.c }] });
    const stale = await ops(id, agent, {
      ops: [{ op: 'replaceRange', from: main('b'), to: main('d'), blocks: ['X'], expectVersions: { b: w.b, c: w.c, d: w.d } }],
    });
    expect(stale.outcomes[0]).toMatchObject({ status: 'conflict', refusal: { code: 'target_changed', details: { blocks: [{ blockId: 'c' }] } } });
    expect(await markdownOf(id, agent)).toEqual(['A', 'B', 'C changed', 'D']);
  });

  it('replacement that drops commented text needs the override', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Keep this'), paragraph('b', 'Remove this part'), paragraph('c', 'Resolved note')]);
    const threadId = await comment(id, 'b', 'this part');
    await comment(id, 'c', 'note', { resolved: true });
    const v = await versions(id, agent);

    // A resolved thread doesn't hold its text.
    const resolvedOk = await ops(id, agent, { ops: [{ op: 'delete', target: main('c'), expectVersion: v.c }] });
    expect(resolvedOk.outcomes[0]).toMatchObject({ status: 'applied' });

    const held = await ops(id, agent, {
      ops: [
        { op: 'update', target: main('b'), block: 'Remove', expectVersion: v.b },
        { op: 'update', target: main('a'), block: 'Keep this, edited', expectVersion: v.a },
      ],
    });
    expect(held.outcomes[0]).toMatchObject({
      status: 'conflict',
      refusal: { code: 'deletes_commented_text', details: { threads: [{ threadId, quote: 'this part' }] } },
    });
    expect(held.outcomes[1]).toMatchObject({ status: 'applied' });
    const deleteHeld = await ops(id, agent, { ops: [{ op: 'delete', target: main('b'), expectVersion: v.b }] });
    expect(deleteHeld.outcomes[0]!.refusal!.code).toBe('deletes_commented_text');

    const forced = await ops(id, agent, { allowCommentedDelete: true, ops: [{ op: 'delete', target: main('b'), expectVersion: v.b }] });
    expect(forced.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(await markdownOf(id, agent)).toEqual(['Keep this, edited']);
  });

  it('markdown list input becomes one block per item', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Intro')]);

    const result = await ops(id, agent, { ops: [{ op: 'add', at: main('a'), position: 'after', blocks: ['- one\n- two\n  - nested\n- three'] }] });

    const read = await getLiveDoc(id, agent, { format: 'markdown' });
    if (!read.ok) throw new Error();
    expect(read.value.blocks.map((b) => [b.type, b.depth, b.markdown])).toEqual([
      ['paragraph', 0, 'Intro'],
      ['bulletListItem', 0, '* one'],
      ['bulletListItem', 0, '* two'],
      ['bulletListItem', 1, '* nested'],
      ['bulletListItem', 0, '* three'],
    ]);
    expect(result.outcomes[0]!.blocks!.map((b) => b.target.blockId)).toEqual(read.value.blocks.filter((b) => b.depth === 0).slice(1).map((b) => b.target.blockId));
  });

  it('raw Yjs updates from agents are impossible', async () => {
    // Bearer (agent) socket connections are read-only (hub.test.ts); the only
    // write path is ops, which accepts no Yjs update.
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const out = await applyOps(id, agent, { baseVersion: 0, ops: [{ op: 'yjs', update: 'AQHGrKqHDQAEAQ==' }] });
    expect(out).toMatchObject({ ok: false, status: 400, errors: [{ index: 0, refusal: { code: 'invalid_op' } }] });
    expect(await markdownOf(id, agent)).toEqual(['Alpha']);
  });
});
