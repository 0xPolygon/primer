import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddVersionResponse,
  VersionPatchRequest,
  VersionSummaryDTO,
  VersionsListResponse,
} from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useVersionsQuery(docId: string) {
  return useQuery({
    queryKey: ['versions', docId],
    queryFn: async ({ signal }): Promise<VersionsListResponse> => {
      const res = await api(`/api/documents/${docId}/versions`, { signal });
      if (!res.ok) throw new Error(`versions fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: docId.length > 0,
    staleTime: 30_000,
  });
}

export function useAddVersion(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; versionNote: string | null }): Promise<AddVersionResponse> => {
      const fd = new FormData();
      fd.append('file', input.file);
      if (input.versionNote !== null) fd.append('versionNote', input.versionNote);
      const res = await api(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`add version failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', docId] });
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useEditVersionNote(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (versionNote: string | null): Promise<VersionSummaryDTO> => {
      const payload: VersionPatchRequest = { versionNote };
      const res = await api(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`edit version note failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      // We don't know the docId here; invalidate all versions queries.
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
  });
}
