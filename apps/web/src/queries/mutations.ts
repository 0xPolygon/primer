import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AnchorData,
  CommentDTO,
  CreateThreadRequest,
  ThreadDTO,
} from '@primer/shared';
import { clearThreadsEtag, type ThreadsQueryShape } from './threads.ts';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

function mergeThreadIntoCache(
  qc: ReturnType<typeof useQueryClient>,
  versionId: string,
  thread: ThreadDTO
) {
  qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
    if (!prev) return prev;
    const exists = prev.data.threads.some((t) => t.id === thread.id);
    const threads = exists
      ? prev.data.threads.map((t) => (t.id === thread.id ? thread : t))
      : [...prev.data.threads, thread];
    return { ...prev, data: { ...prev.data, threads } };
  });
}

function applyCommentToCache(
  qc: ReturnType<typeof useQueryClient>,
  versionId: string,
  updated: CommentDTO
) {
  qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      data: {
        ...prev.data,
        threads: prev.data.threads.map((t) =>
          t.id === updated.threadId
            ? { ...t, comments: t.comments.map((c) => (c.id === updated.id ? updated : c)) }
            : t
        ),
      },
    };
  });
}

export function useCreateThread(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { anchor: AnchorData; body: string }) => {
      const payload: CreateThreadRequest = { anchor: input.anchor, body: input.body };
      const res = await fetch(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (newThread) => {
      mergeThreadIntoCache(qc, versionId, newThread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReply(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return jsonOrThrow<{ comment: CommentDTO; thread: ThreadDTO }>(res);
    },
    onSuccess: (out) => {
      mergeThreadIntoCache(qc, versionId, out.thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useResolveThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}/resolve`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      mergeThreadIntoCache(qc, versionId, thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReopenThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}/reopen`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      mergeThreadIntoCache(qc, versionId, thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useEditComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (updated) => {
      applyCommentToCache(qc, versionId, updated);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useDeleteComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (tombstone) => {
      applyCommentToCache(qc, versionId, tombstone);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}
