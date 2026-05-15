import { logger } from '../logger.ts';

export interface NotifyMentionsArgs {
  mentions: string[];
  threadId: string;
  commentId: string;
  actorUserId: string;
}

export interface NotifyReplyParticipantsArgs {
  participantUserIds: string[];
  threadId: string;
  commentId: string;
  actorUserId: string;
}

export interface Notifier {
  notifyMentions(args: NotifyMentionsArgs): Promise<void>;
  notifyReplyParticipants(args: NotifyReplyParticipantsArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyMentions(args: NotifyMentionsArgs): Promise<void> {
    logger.debug({ args }, 'notifyMentions (no-op)');
  }
  async notifyReplyParticipants(args: NotifyReplyParticipantsArgs): Promise<void> {
    logger.debug({ args }, 'notifyReplyParticipants (no-op)');
  }
}
