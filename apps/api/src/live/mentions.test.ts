import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { blockToNode } from '@blocknote/core';
import { db } from '../db/client.ts';
import { documents, users } from '../db/schema.ts';
import type { NotifyDocumentMentionArgs, Notifier } from '../notifications/notifier.ts';
import { AGENT, OWNER, VIEWER, seedRecordsDoc } from '../records/records.testlib.ts';
import { serverEditor } from './editor.ts';
import { flushMentionSync, registerMentionNotifications } from './mentions.ts';
import { applyPlan } from './pipeline.ts';

class SpyNotifier implements Notifier {
  readonly emailEnabled = false;
  mentions: NotifyDocumentMentionArgs[] = [];
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
  async notifyExternalOtp() {}
  async notifyExternalFirstView() {}
  async notifyDocumentMention(args: NotifyDocumentMentionArgs) {
    this.mentions.push(args);
  }
}

const STRANGER = { id: 'rec-stranger', email: 'stranger@p.t', displayName: 'Dee', kind: 'person' as const, viaUserId: null };

/** Appends a paragraph mentioning `userIds`, as `actorId`. */
async function mention(doc: string, actorId: string, kind: 'person' | 'agent', blockId: string, userIds: string[]) {
  const node = blockToNode(
    {
      id: blockId,
      type: 'paragraph',
      content: [...userIds.flatMap((userId) => [{ type: 'mention', props: { userId, name: userId } }, ' ']), 'please look'],
    } as never,
    serverEditor().editor.pmSchema,
  );
  await applyPlan(doc, { kind, actorId, runId: null }, {
    onConflict: 'refuse',
    edits: [{ target: { tabId: 'main', blockId: '' }, inverse: false, build: (tr) => void tr.insert(1 + tr.doc.firstChild!.content.size, node) }],
  });
}

describe('mention chips', () => {
  it('a mention chip notifies the mentioned person', async () => {
    const spy = new SpyNotifier();
    registerMentionNotifications(spy);
    const doc = await seedRecordsDoc();
    await db.update(documents).set({ format: 'markdown' }).where(eq(documents.id, doc));
    await db.insert(users).values(STRANGER).onConflictDoNothing();

    // A person who can read the document is told once; an agent, a person who
    // can't read it, and the author themself are not.
    await mention(doc, OWNER.id, 'person', 'm-1', [VIEWER.id, AGENT.id, STRANGER.id, OWNER.id]);
    await flushMentionSync();
    expect(spy.mentions).toEqual([
      { doc: { id: doc, title: 'Poll' }, blockId: 'm-1', mentionedUserId: VIEWER.id, actorUserId: OWNER.id },
    ]);

    // Later edits don't announce it again; a new block mentioning them does,
    // in the name of whoever wrote it.
    await mention(doc, AGENT.id, 'agent', 'm-2', [VIEWER.id]);
    await flushMentionSync();
    expect(spy.mentions.map((m) => [m.blockId, m.actorUserId])).toEqual([
      ['m-1', OWNER.id],
      ['m-2', AGENT.id],
    ]);
  });
});
