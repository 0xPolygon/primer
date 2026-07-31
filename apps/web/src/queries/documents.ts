import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentDetailResponse, DocumentPatchRequest } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

export function useDocument(docId: string) {
  return useQuery({
    queryKey: ['document', docId],
    queryFn: async (): Promise<DocumentDetailResponse> => {
      const res = await api(`/api/documents/${docId}`);
      if (res.status === 404) {
        throw new Error('not_found');
      }
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      }
      return res.json();
    },
  });
}

export function useEditDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DocumentPatchRequest) => {
      const res = await api(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`edit doc failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useDeleteDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ id: string; deletedAt: string }> => {
      const res = await api(`/api/documents/${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useRestoreDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/documents/${docId}/restore`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`restore failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}
