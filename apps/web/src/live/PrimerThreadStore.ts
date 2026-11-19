import * as Y from 'yjs';
import { absolutePositionToRelativePosition, ySyncPluginKey } from 'y-prosemirror';
import type { BlockNoteEditor } from '@blocknote/core';
import { ThreadStore, ThreadStoreAuth, type CommentData, type ThreadData } from '@blocknote/core/comments';
import type { CommentDTO, LiveAnchor, ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

/** The viewer as the store needs it: who they are and what they may do. */
export type StoreViewer = { id: string; isOwner: boolean; canComment: boolean };

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * BlockNote's comments UI over Primer's threads (modelled on BlockNote's
 * RESTYjsThreadStore). Threads live in Postgres; the comment marks that
 * anchor them are written by the server, never by this browser: creating a
 * thread sends the selection as Yjs relative positions and the server places
 * the mark through its pipeline (a commenter's connection is read-only).
 * One store per tab editor; it lists that tab's threads.
 */
export class PrimerThreadStore extends ThreadStore {
  private threads = new Map<string, ThreadData>();
  private subscribers = new Set<(threads: Map<string, ThreadData>) => void>();
  /** Display names of the people and agents seen in threads. */
  readonly names = new Map<string, string>();
  /** Set once the editor exists: thread creation reads its selection. */
  editor: BlockNoteEditor<any, any, any> | null = null;

  constructor(
    private readonly documentId: string,
    private readonly tabId: string,
    viewer: StoreViewer,
    private readonly fetcher: Fetch = api,
  ) {
    super(new PrimerThreadStoreAuth(viewer));
  }

  /** Re-reads the document's live threads (on load and on thread events).
   *  A failed read keeps what is shown; the next event reads again. */
  async refresh(): Promise<void> {
    const res = await this.fetcher(`/api/documents/${this.documentId}/threads`).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json()) as ThreadsListResponse;
    const next = new Map<string, ThreadData>();
    for (const dto of body.threads) {
      if (!('target' in dto.anchor) || dto.anchor.target.tabId !== this.tabId) continue;
      next.set(dto.id, this.toThreadData(dto));
    }
    this.threads = next;
    for (const cb of this.subscribers) cb(this.threads);
  }

  /** Open threads' ids: deleting their commented text asks first. */
  openThreadIds(): Set<string> {
    return new Set([...this.threads.values()].filter((t) => !t.resolved).map((t) => t.id));
  }

  /** The quote of a thread, for the delete warning. */
  quoteOf(threadId: string): string {
    return (this.threads.get(threadId)?.metadata as { quote?: string } | undefined)?.quote ?? '';
  }

  toThreadData(dto: ThreadDTO): ThreadData {
    const comments = dto.comments.map((c) => this.toCommentData(c));
    const last = comments.reduce((at, c) => (c.updatedAt > at ? c.updatedAt : at), new Date(dto.createdAt));
    return {
      type: 'thread',
      id: dto.id,
      createdAt: new Date(dto.createdAt),
      updatedAt: last,
      comments,
      resolved: dto.resolvedAt !== null,
      resolvedUpdatedAt: dto.resolvedAt ? new Date(dto.resolvedAt) : undefined,
      resolvedBy: dto.resolvedBy ?? undefined,
      metadata: {
        orphaned: dto.orphaned,
        quote: dto.anchor.type === 'prose' ? dto.anchor.quote : '',
        starterId: dto.comments[0]?.authorId ?? null,
      },
    };
  }

  private toCommentData(c: CommentDTO): CommentData {
    this.names.set(c.authorId, c.authorDisplayName);
    const base = {
      type: 'comment' as const,
      id: c.id,
      userId: c.authorId,
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt ?? c.createdAt),
      reactions: c.reactions.map((r) => ({ emoji: r.emoji, createdAt: new Date(c.createdAt), userIds: r.userIds })),
      metadata: {},
    };
    return c.deletedAt
      ? { ...base, deletedAt: new Date(c.deletedAt), body: undefined }
      : { ...base, body: textToBody(c.body) };
  }

  /** The thread's comment mark is placed by the server in createThread. */
  addThreadToDocument = async (): Promise<void> => undefined;

  createThread = async (options: { initialComment: { body: unknown } }): Promise<ThreadData> => {
    const editor = this.editor;
    if (!editor) throw new Error('the editor is not ready');
    const { from, to } = editor.prosemirrorState.selection;
    const binding = ySyncPluginKey.getState(editor.prosemirrorState)?.binding;
    if (!binding) throw new Error('the document is not connected');
    const encode = (pos: number) =>
      toBase64(Y.encodeRelativePosition(absolutePositionToRelativePosition(pos, binding.type, binding.mapping)));
    const blockId = editor.getTextCursorPosition().block.id;
    const anchor: LiveAnchor = {
      type: 'prose',
      target: { tabId: this.tabId, blockId },
      quote: editor.prosemirrorState.doc.textBetween(from, to, '\n') || ' ',
    };
    const res = await this.fetcher(`/api/documents/${this.documentId}/threads`, json('POST', {
      anchor,
      body: bodyToText(options.initialComment.body),
      selection: { anchor: encode(from), head: encode(to) },
    }));
    if (!res.ok) throw new Error(await refusalOf(res));
    const thread = this.toThreadData((await res.json()) as ThreadDTO);
    this.threads.set(thread.id, thread);
    for (const cb of this.subscribers) cb(this.threads);
    return thread;
  };

  addComment = async (options: { comment: { body: unknown }; threadId: string }): Promise<CommentData> => {
    const res = await this.mutate(`/api/threads/${options.threadId}/comments`, json('POST', { body: bodyToText(options.comment.body) }));
    const out = (await res.json()) as { comment: CommentDTO };
    return this.toCommentData(out.comment);
  };

  updateComment = async (options: { comment: { body: unknown }; commentId: string }): Promise<void> => {
    await this.mutate(`/api/comments/${options.commentId}`, json('PATCH', { body: bodyToText(options.comment.body) }));
  };

  deleteComment = async (options: { commentId: string }): Promise<void> => {
    await this.mutate(`/api/comments/${options.commentId}`, { method: 'DELETE' });
  };

  deleteThread = async (): Promise<void> => {
    throw new Error('Threads are resolved, not deleted.');
  };

  resolveThread = async (options: { threadId: string }): Promise<void> => {
    await this.mutate(`/api/threads/${options.threadId}/resolve`, { method: 'POST' });
  };

  unresolveThread = async (options: { threadId: string }): Promise<void> => {
    await this.mutate(`/api/threads/${options.threadId}/reopen`, { method: 'POST' });
  };

  addReaction = async (options: { commentId: string; emoji: string }): Promise<void> => {
    await this.mutate(`/api/comments/${options.commentId}/reactions/${encodeURIComponent(options.emoji)}`, { method: 'POST' });
  };

  deleteReaction = async (options: { commentId: string; emoji: string }): Promise<void> => {
    await this.mutate(`/api/comments/${options.commentId}/reactions/${encodeURIComponent(options.emoji)}`, { method: 'DELETE' });
  };

  getThread = (threadId: string): ThreadData => {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);
    return thread;
  };

  getThreads = (): Map<string, ThreadData> => this.threads;

  subscribe = (cb: (threads: Map<string, ThreadData>) => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  private async mutate(path: string, init: RequestInit): Promise<Response> {
    const res = await this.fetcher(path, init);
    if (!res.ok) throw new Error(await refusalOf(res));
    void this.refresh();
    return res;
  }
}

/**
 * Mirrors the server's rules so the UI only offers what will succeed:
 * commenting needs comment access; people edit and delete their own
 * comments; the owner or the thread's starter resolves; threads are never
 * deleted.
 */
export class PrimerThreadStoreAuth extends ThreadStoreAuth {
  constructor(private readonly viewer: StoreViewer) {
    super();
  }
  canCreateThread = () => this.viewer.canComment;
  canAddComment = () => this.viewer.canComment;
  canUpdateComment = (comment: CommentData) => comment.userId === this.viewer.id;
  canDeleteComment = (comment: CommentData) => comment.userId === this.viewer.id;
  canDeleteThread = () => false;
  canResolveThread = (thread: ThreadData) => this.mayResolve(thread);
  canUnresolveThread = (thread: ThreadData) => this.mayResolve(thread);
  canAddReaction = () => this.viewer.canComment;
  canDeleteReaction = () => this.viewer.canComment;
  private mayResolve(thread: ThreadData): boolean {
    return this.viewer.isOwner || (thread.metadata as { starterId?: string }).starterId === this.viewer.id;
  }
}

/** Primer stores comment text; BlockNote's comment editor holds blocks. */
export function bodyToText(body: unknown): string {
  const blocks = Array.isArray(body) ? (body as { content?: unknown }[]) : [];
  return blocks
    .map((block) =>
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as { type?: string; text?: string }[]).map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('')
          : '',
    )
    .join('\n')
    .trim();
}

export function textToBody(text: string): { type: 'paragraph'; content: string }[] {
  return text.split('\n').map((line) => ({ type: 'paragraph', content: line }));
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function refusalOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { refusal?: { message: string; fix: string } } | null;
  return body?.refusal ? `${body.refusal.message} ${body.refusal.fix}` : `Request failed (${res.status}).`;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
