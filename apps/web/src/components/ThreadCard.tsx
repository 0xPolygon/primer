import { useState } from 'react';
import type { CommentDTO, ThreadDTO } from '@primer/shared';
import {
  useReply,
  useResolveThread,
  useReopenThread,
  useEditComment,
  useDeleteComment,
} from '../queries/mutations.ts';
import { MentionTextarea } from './MentionTextarea.tsx';
import { renderMentions } from './renderMentions.tsx';
import { useMentionableUsers } from '../queries/users.ts';

interface Props {
  versionId: string;
  thread: ThreadDTO;
  drifted: boolean;
  currentUserId: string;
  onHighlight: (anchorId: string) => void;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function anchorPreview(t: ThreadDTO): string {
  if (t.anchor.type === 'text-range') {
    const text = t.anchor.selectorText;
    return `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`;
  }
  // element-path: prefer the captured innerText; fall back to the CSS path
  // for legacy rows that pre-date innerText capture.
  const inner = t.anchor.innerText;
  if (inner && inner.length > 0) {
    return `"${inner.slice(0, 60)}${inner.length > 60 ? '…' : ''}"`;
  }
  return t.anchor.path;
}

// Inline icons (Lucide-style outline marks). Stroke uses currentColor.
function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function TrashIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
function ReplyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}
function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function ReopenIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

const iconButtonClass =
  'inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40';

const footerButtonClass =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50';

function CommentRow({
  comment,
  isReply,
  isAuthor,
  versionId,
}: {
  comment: CommentDTO;
  isReply: boolean;
  isAuthor: boolean;
  versionId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [editMentions, setEditMentions] = useState<string[]>(comment.mentions);
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const usersQ = useMentionableUsers();
  const isTombstoned = comment.deletedAt !== null;
  const canShowAuthorActions = !isTombstoned && !editing && isAuthor;

  return (
    <div className={isReply ? 'mt-1.5 ml-3 border-t border-dashed border-neutral-200 pt-1.5' : ''}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span className="truncate font-semibold text-neutral-800">{comment.authorDisplayName}</span>
        <div className="flex shrink-0 items-center gap-1">
          {canShowAuthorActions && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Edit comment"
                className={iconButtonClass}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                onClick={() => del.mutate()}
                disabled={del.isPending}
                aria-label="Delete comment"
                className={iconButtonClass}
              >
                <TrashIcon />
              </button>
            </>
          )}
          <span className="whitespace-nowrap">
            {relativeTime(comment.createdAt)}
            {comment.updatedAt && !isTombstoned && (
              <span className="ml-1 italic text-neutral-400">(edited)</span>
            )}
          </span>
        </div>
      </div>
      {isTombstoned ? (
        <div className="italic text-neutral-400">deleted by author</div>
      ) : editing ? (
        <div className="mt-1">
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            onMentionsChange={setEditMentions}
            rows={2}
            autoFocus
            initialSelectedIds={comment.mentions}
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
                setEditMentions(comment.mentions);
              }}
              className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={edit.isPending || draft.trim().length === 0}
              onClick={() => {
                edit.mutate(
                  { body: draft.trim(), mentions: editMentions },
                  { onSuccess: () => setEditing(false) }
                );
              }}
              className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 leading-snug text-neutral-900">
          {renderMentions(comment.body, comment.mentions, usersQ.data ?? [])}
        </div>
      )}
    </div>
  );
}

export function ThreadCard({ versionId, thread, drifted, currentUserId, onHighlight }: Props) {
  const [replying, setReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [replyMentions, setReplyMentions] = useState<string[]>([]);
  const reply = useReply(versionId, thread.id);
  const resolve = useResolveThread(versionId, thread.id);
  const reopen = useReopenThread(versionId, thread.id);
  const isResolved = thread.resolvedAt !== null;
  const [first, ...replies] = thread.comments;

  return (
    <article
      id={`thread-${thread.id}`}
      className={`border-b border-neutral-100 px-3 py-2.5 text-xs ${
        isResolved ? 'opacity-55' : ''
      } ${drifted ? 'opacity-60' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
        onHighlight(thread.id);
      }}
    >
      <div className="mb-1.5 flex items-start gap-1 border-l-2 border-yellow-300 pl-2 italic leading-snug text-neutral-600">
        {drifted && <span title="Could not place anchor" className="not-italic">📍?</span>}
        <span className="truncate">{anchorPreview(thread)}</span>
      </div>
      {first && (
        <CommentRow
          comment={first}
          isReply={false}
          isAuthor={first.authorId === currentUserId}
          versionId={versionId}
        />
      )}
      {replies.map((r) => (
        <CommentRow
          key={r.id}
          comment={r}
          isReply
          isAuthor={r.authorId === currentUserId}
          versionId={versionId}
        />
      ))}
      {replying && (
        <div className="mt-2">
          <MentionTextarea
            value={replyDraft}
            onChange={setReplyDraft}
            onMentionsChange={setReplyMentions}
            placeholder="Write a reply…"
            rows={2}
            autoFocus
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReplying(false);
                setReplyDraft('');
                setReplyMentions([]);
              }}
              className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reply.isPending || replyDraft.trim().length === 0}
              onClick={() =>
                reply.mutate(
                  { body: replyDraft.trim(), mentions: replyMentions },
                  {
                    onSuccess: () => {
                      setReplyDraft('');
                      setReplyMentions([]);
                      setReplying(false);
                    },
                  }
                )
              }
              className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              Reply
            </button>
          </div>
        </div>
      )}
      {!replying && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-neutral-100 pt-1.5">
          <button type="button" onClick={() => setReplying(true)} className={footerButtonClass}>
            <ReplyIcon />
            Reply
          </button>
          {isResolved ? (
            <button type="button" onClick={() => reopen.mutate()} className={footerButtonClass}>
              <ReopenIcon />
              Reopen
            </button>
          ) : (
            <button type="button" onClick={() => resolve.mutate()} className={footerButtonClass}>
              <CheckIcon />
              Resolve
            </button>
          )}
        </div>
      )}
    </article>
  );
}
