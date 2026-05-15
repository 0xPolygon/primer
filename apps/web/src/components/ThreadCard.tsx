import { useState } from 'react';
import type { CommentDTO, ThreadDTO } from '@primer/shared';
import {
  useReply,
  useResolveThread,
  useReopenThread,
  useEditComment,
  useDeleteComment,
} from '../queries/mutations.ts';

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
  return t.anchor.path;
}

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
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const isTombstoned = comment.deletedAt !== null;

  return (
    <div className={isReply ? 'mt-1 ml-3 border-t border-dashed border-neutral-200 pt-1' : ''}>
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span className="font-semibold text-neutral-800">{comment.authorDisplayName}</span>
        <span>
          {relativeTime(comment.createdAt)}
          {comment.updatedAt && !isTombstoned && (
            <span className="ml-1 italic text-neutral-400">(edited)</span>
          )}
        </span>
      </div>
      {isTombstoned ? (
        <div className="italic text-neutral-400">deleted by author</div>
      ) : editing ? (
        <div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={5000}
            className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[10px] text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={edit.isPending || draft.trim().length === 0}
              onClick={() => {
                edit.mutate(draft.trim(), { onSuccess: () => setEditing(false) });
              }}
              className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="leading-tight text-neutral-900">{comment.body}</div>
      )}
      {!isTombstoned && !editing && isAuthor && (
        <div className="mt-0.5 flex gap-2 text-[9px] text-neutral-500">
          <button type="button" onClick={() => setEditing(true)} className="underline">
            Edit
          </button>
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => del.mutate()}
            className="underline"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function ThreadCard({ versionId, thread, drifted, currentUserId, onHighlight }: Props) {
  const [replying, setReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const reply = useReply(versionId, thread.id);
  const resolve = useResolveThread(versionId, thread.id);
  const reopen = useReopenThread(versionId, thread.id);
  const isResolved = thread.resolvedAt !== null;
  const [first, ...replies] = thread.comments;

  return (
    <article
      className={`border-b border-neutral-100 px-3 py-2 text-xs ${
        isResolved ? 'opacity-55' : ''
      } ${drifted ? 'opacity-60' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
        onHighlight(thread.id);
      }}
    >
      <div className="mb-1 flex items-start gap-1 border-l-2 border-yellow-300 pl-2 italic leading-tight text-neutral-600">
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
          <textarea
            autoFocus
            value={replyDraft}
            onChange={(e) => setReplyDraft(e.target.value)}
            rows={2}
            maxLength={5000}
            placeholder="Write a reply…"
            className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReplying(false);
                setReplyDraft('');
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[10px] text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reply.isPending || replyDraft.trim().length === 0}
              onClick={() =>
                reply.mutate(replyDraft.trim(), {
                  onSuccess: () => {
                    setReplyDraft('');
                    setReplying(false);
                  },
                })
              }
              className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
            >
              Reply
            </button>
          </div>
        </div>
      )}
      <div className="mt-1 flex gap-2 text-[10px] text-neutral-600">
        {!replying && (
          <button type="button" onClick={() => setReplying(true)} className="underline">
            Reply
          </button>
        )}
        {isResolved ? (
          <button type="button" onClick={() => reopen.mutate()} className="underline">
            Reopen
          </button>
        ) : (
          <button type="button" onClick={() => resolve.mutate()} className="underline">
            Resolve
          </button>
        )}
      </div>
    </article>
  );
}
