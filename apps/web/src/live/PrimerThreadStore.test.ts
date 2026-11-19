import { describe, expect, it } from 'vitest';
import type { ThreadDTO } from '@polygonlabs/primer-api-types';
import { bodyToText, PrimerThreadStore, textToBody } from './PrimerThreadStore.ts';

const dto: ThreadDTO = {
  id: 't1',
  versionId: null,
  versionNumber: null,
  anchor: { type: 'prose', target: { tabId: 'main', blockId: 'b1' }, quote: 'brave' },
  contextChanged: false,
  orphaned: true,
  resolvedAt: '2026-11-19T10:05:00.000Z',
  resolvedBy: 'u1',
  resolvedByDisplayName: 'Ana',
  createdAt: '2026-11-19T10:00:00.000Z',
  comments: [
    {
      id: 'c1', threadId: 't1', authorId: 'u1', authorDisplayName: 'Ana', authorKind: 'person', authorVia: null,
      body: 'Why brave?\nReally?', createdAt: '2026-11-19T10:00:00.000Z', updatedAt: null, deletedAt: null,
      mentions: [], reactions: [{ emoji: '👍', userIds: ['u1', 'u2'] }],
    },
    {
      id: 'c2', threadId: 't1', authorId: 'u2', authorDisplayName: 'Bo', authorKind: 'person', authorVia: null,
      body: '', createdAt: '2026-11-19T10:01:00.000Z', updatedAt: null, deletedAt: '2026-11-19T10:02:00.000Z',
      mentions: [], reactions: [],
    },
  ],
};

describe('PrimerThreadStore', () => {
  it('store maps ThreadDTO to ThreadData and back', async () => {
    const store = new PrimerThreadStore('d1', 'main', { id: 'u2', isOwner: false, canComment: true }, async () =>
      new Response(JSON.stringify({ threads: [dto, { ...dto, id: 't2', anchor: { ...dto.anchor, target: { tabId: 'notes', blockId: 'x' } } }], asOf: '' })),
    );
    await store.refresh();
    expect([...store.getThreads().keys()]).toEqual(['t1']); // this tab only
    const thread = store.getThread('t1');
    expect(thread.resolved).toBe(true);
    expect(thread.resolvedBy).toBe('u1');
    expect(thread.metadata).toMatchObject({ orphaned: true, quote: 'brave', starterId: 'u1' });
    expect(thread.comments[0]!.reactions).toEqual([{ emoji: '👍', createdAt: expect.any(Date), userIds: ['u1', 'u2'] }]);
    expect(bodyToText(thread.comments[0]!.body)).toBe('Why brave?\nReally?');
    expect(thread.comments[1]!.deletedAt).toBeInstanceOf(Date);
    expect(thread.comments[1]!.body).toBeUndefined();
    expect(store.names.get('u2')).toBe('Bo');
    // Only the owner or the starter resolves; people edit their own comments.
    expect(store.auth.canResolveThread(thread)).toBe(false);
    expect(store.auth.canUpdateComment(thread.comments[1]!)).toBe(true);
    expect(store.auth.canUpdateComment(thread.comments[0]!)).toBe(false);
    expect(bodyToText(textToBody('a\nb'))).toBe('a\nb');
  });
});
