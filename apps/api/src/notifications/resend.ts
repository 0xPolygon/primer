import { inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import { logger } from '../logger.ts';
import type { Notifier, NotifyCommentArgs } from './notifier.ts';

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  appBaseUrl: string; // e.g. https://primer-polygon.up.railway.app
}

interface UserRow {
  id: string;
  displayName: string;
  email: string;
}

const SUBJECT_TITLE_LIMIT = 50;
const BODY_EXCERPT_LIMIT = 280;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signalLead(actorName: string, mention: boolean, reply: boolean): string {
  if (mention && reply) return `${actorName} mentioned you and replied to a thread you're in.`;
  if (mention) return `${actorName} mentioned you in a comment.`;
  return `${actorName} replied to a thread you're in.`;
}

function renderSubject(actorName: string, docTitle: string): string {
  return `${actorName} commented on '${truncate(docTitle, SUBJECT_TITLE_LIMIT)}'`;
}

function renderText(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
): string {
  return [
    signalLead(actorName, mention, reply),
    '',
    `Doc: ${docTitle}`,
    '',
    commentExcerpt,
    '',
    `Open thread: ${url}`,
    '',
    'You received this because you were mentioned or are a participant in this Primer thread.',
  ].join('\n');
}

function renderHtml(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
): string {
  const lead = escapeHtml(signalLead(actorName, mention, reply));
  const safeTitle = escapeHtml(docTitle);
  const safeExcerpt = escapeHtml(commentExcerpt).replace(/\n/g, '<br/>');
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">${lead}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#737373;">Doc: <strong style="color:#171717;">${safeTitle}</strong></p>
    <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #fbbf24;background:#fef9c3;font-size:14px;line-height:1.5;color:#262626;">${safeExcerpt}</blockquote>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open thread</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were mentioned or are a participant in this Primer thread.</p>
  </td></tr>
</table>
</body></html>`;
}

export class ResendNotifier implements Notifier {
  constructor(private readonly cfg: ResendConfig) {}

  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    const mentionSet = new Set(args.mentionedUserIds);
    const participantSet = new Set(args.participantUserIds);
    const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
    recipientIds.delete(args.actorUserId);
    if (recipientIds.size === 0) return;

    const rows = (await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, [...recipientIds, args.actorUserId]))) as UserRow[];
    const actor = rows.find((u) => u.id === args.actorUserId);
    const actorName = actor?.displayName ?? 'Someone';

    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.doc.id}/v/${args.version.versionNumber}#thread-${args.thread.id}`;
    const excerpt = truncate(args.comment.body, BODY_EXCERPT_LIMIT);
    const subject = renderSubject(actorName, args.doc.title);

    for (const recipientId of recipientIds) {
      const recipient = rows.find((u) => u.id === recipientId);
      if (!recipient) {
        logger.warn({ recipientId }, 'recipient not found in users table, skipping');
        continue;
      }
      const mention = mentionSet.has(recipientId);
      const reply = participantSet.has(recipientId);
      const html = renderHtml(actorName, args.doc.title, excerpt, url, mention, reply);
      const text = renderText(actorName, args.doc.title, excerpt, url, mention, reply);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.cfg.fromAddress,
            to: recipient.email,
            subject,
            html,
            text,
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          logger.error(
            { status: res.status, recipientId, errBody: errBody.slice(0, 300) },
            'resend send failed',
          );
        }
      } catch (err) {
        logger.error({ err, recipientId }, 'resend fetch threw');
      }
    }
  }
}
