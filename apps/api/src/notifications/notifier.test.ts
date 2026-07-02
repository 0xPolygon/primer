import { describe, it, expect } from 'vitest';
import { NoopNotifier, type NotifyCommentArgs, type NotifyCollaboratorAddedArgs } from './notifier.ts';

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

const COLLAB_ARGS: NotifyCollaboratorAddedArgs = {
  docId: 'doc-1',
  docTitle: 'Test Doc',
  addedUserId: 'mock-user-2',
  addedByUserId: 'mock-user-1',
  role: 'editor',
};

describe('NoopNotifier.notifyCollaboratorAdded', () => {
  it('resolves without error', async () => {
    const n = new NoopNotifier();
    await expect(n.notifyCollaboratorAdded(COLLAB_ARGS)).resolves.toBeUndefined();
  });

  it('resolves without error even on self-add (still a no-op)', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyCollaboratorAdded({ ...COLLAB_ARGS, addedUserId: COLLAB_ARGS.addedByUserId }),
    ).resolves.toBeUndefined();
  });
});
