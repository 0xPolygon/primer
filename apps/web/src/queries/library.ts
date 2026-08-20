import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { LibraryResponse, FolderDTO } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

const LIBRARY_KEY = ['library'] as const;

export function useLibraryQuery() {
  return useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: async ({ signal }): Promise<LibraryResponse> => {
      const res = await api('/api/library', { signal });
      if (!res.ok) throw new Error(`library fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useCreateFolder(): UseMutationResult<FolderDTO, Error, { name: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name }) => {
      const res = await api('/api/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`create folder failed: ${res.status}`);
      return (await res.json()) as FolderDTO;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useRenameFolder(): UseMutationResult<FolderDTO, Error, { id: string; name: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }) => {
      const res = await api(`/api/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`rename folder failed: ${res.status}`);
      return (await res.json()) as FolderDTO;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useDeleteFolder(): UseMutationResult<void, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      const res = await api(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete folder failed: ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}

export function useAssignFolder(): UseMutationResult<void, Error, { docId: string; folderId: string | null }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId, folderId }) => {
      const res = await api(`/api/documents/${encodeURIComponent(docId)}/folder`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(`assign folder failed: ${res.status}`);
    },
    onMutate: async ({ docId, folderId }) => {
      await qc.cancelQueries({ queryKey: LIBRARY_KEY });
      const previous = qc.getQueryData<LibraryResponse>(LIBRARY_KEY);
      if (previous) {
        qc.setQueryData<LibraryResponse>(LIBRARY_KEY, {
          ...previous,
          documents: previous.documents.map((d) => (d.id === docId ? { ...d, folderId } : d)),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(LIBRARY_KEY, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: LIBRARY_KEY });
    },
  });
}
