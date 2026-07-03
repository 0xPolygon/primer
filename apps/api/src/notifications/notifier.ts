import { logger } from '../logger.ts';
import type { CollaboratorRole } from '../lib/permissions.ts';

export interface NotifyCollaboratorAddedArgs {
  docId: string;
  docTitle: string;
  addedUserId: string;
  addedByUserId: string;
  role: CollaboratorRole;
}

export interface NotifyCommentArgs {
  doc: { id: string; title: string };
  version: { id: string; versionNumber: number };
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  uploaderUserId: string | null;
  actorUserId: string;
}

export interface Notifier {
  notifyComment(args: NotifyCommentArgs): Promise<void>;
  notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
    if (args.addedUserId === args.addedByUserId) return;
    logger.debug({ args }, 'notifyCollaboratorAdded (no-op)');
  }
}
