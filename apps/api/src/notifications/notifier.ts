import { logger } from '../logger.ts';

export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  actorUserId: string;
}

export interface Notifier {
  notifyComment(args: NotifyCommentArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
}
