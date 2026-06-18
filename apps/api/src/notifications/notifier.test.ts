import { describe, it, expect } from 'vitest';
import { NoopNotifier, type NotifyCommentArgs } from './notifier.ts';

const ARGS: NotifyCommentArgs = {
  doc: { id: 'doc-1', title: 'Test Doc' },
  version: { id: 'v-1', versionNumber: 1 },
  thread: { id: 't-1' },
  comment: { id: 'c-1', body: 'hi', createdAt: new Date() },
  mentionedUserIds: [],
  participantUserIds: [],
  uploaderUserId: null,
  actorUserId: 'mock-user-1',
};

describe('NoopNotifier', () => {
  it('resolves without error', async () => {
    const n = new NoopNotifier();
    await expect(n.notifyComment(ARGS)).resolves.toBeUndefined();
  });
});
