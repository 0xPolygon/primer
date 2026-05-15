import { describe, it, expect } from 'vitest';
import { NoopNotifier } from './notifier.ts';

describe('NoopNotifier', () => {
  it('notifyMentions resolves without throwing', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyMentions({
        mentions: ['user-2'],
        threadId: 'thread-1',
        commentId: 'comment-1',
        actorUserId: 'mock-user-1',
      })
    ).resolves.toBeUndefined();
  });

  it('notifyReplyParticipants resolves without throwing', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyReplyParticipants({
        participantUserIds: ['user-2', 'user-3'],
        threadId: 'thread-1',
        commentId: 'comment-1',
        actorUserId: 'mock-user-1',
      })
    ).resolves.toBeUndefined();
  });
});
