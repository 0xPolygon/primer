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
  /** Null for a comment on a live document. */
  version: { id: string; versionNumber: number } | null;
  thread: { id: string };
  comment: { id: string; body: string; createdAt: Date };
  mentionedUserIds: string[];
  participantUserIds: string[];
  uploaderUserId: string | null;
  actorUserId: string;
}

export interface NotifyExternalOtpArgs {
  toEmail: string;
  code: string;
}

export interface NotifyExternalFirstViewArgs {
  sharerUserId: string;
  viewerEmail: string;
  docId: string;
  docTitle: string;
}

export interface Notifier {
  /**
   * Whether OTP emails can actually reach recipients. The external-share
   * request-code route returns 503 when false, instead of pretending to send.
   */
  readonly emailEnabled: boolean;
  notifyComment(args: NotifyCommentArgs): Promise<void>;
  notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void>;
  notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void>;
  notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  // Dev/test keep the OTP flow usable without Mailgun: codes are logged.
  // In production a Noop notifier means external sharing is unusable → 503.
  readonly emailEnabled = process.env.NODE_ENV !== 'production';

  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    logger.debug({ args }, 'notifyComment (no-op)');
  }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
    if (args.addedUserId === args.addedByUserId) return;
    logger.debug({ args }, 'notifyCollaboratorAdded (no-op)');
  }
  async notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void> {
    logger.info({ toEmail: args.toEmail, code: args.code }, 'external OTP code (no-op notifier, dev only)');
  }
  async notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void> {
    logger.debug({ args }, 'notifyExternalFirstView (no-op)');
  }
}
