import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddExternalRecipientRequest, ExternalShareResponse, ExternalShareViewsResponse,
} from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

const key = (docId: string) => ['external-share', docId] as const;

export function useExternalShare(docId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(docId),
    enabled,
    queryFn: async (): Promise<ExternalShareResponse | null> => {
      const res = await api(`/api/documents/${docId}/external-share`);
      if (res.status === 403) return null; // not a manager: hide the panel
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ExternalShareResponse;
    },
  });
}

/** Audit log for the share's external views. Fetched only while the
 *  activity modal is open — pass its open state as `enabled`. */
export function useExternalShareViews(docId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['external-share-views', docId] as const,
    enabled,
    queryFn: async (): Promise<ExternalShareViewsResponse> => {
      const res = await api(`/api/documents/${docId}/external-share/views`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ExternalShareViewsResponse;
    },
  });
}

function useInvalidating<TArgs>(docId: string, fn: (args: TArgs) => Promise<Response>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      const res = await fn(args);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(docId) });
      void qc.invalidateQueries({ queryKey: ['document', docId] }); // badge flag
    },
  });
}

export function useCreateExternalShare(docId: string) {
  return useInvalidating<void>(docId, () =>
    api(`/api/documents/${docId}/external-share`, { method: 'POST' }));
}
export function useRevokeExternalShare(docId: string) {
  return useInvalidating<void>(docId, () =>
    api(`/api/documents/${docId}/external-share`, { method: 'DELETE' }));
}
export function useAddExternalRecipient(docId: string) {
  return useInvalidating<AddExternalRecipientRequest>(docId, (body) =>
    api(`/api/documents/${docId}/external-share/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
}
export function useRevokeExternalRecipient(docId: string) {
  return useInvalidating<{ recipientId: string }>(docId, ({ recipientId }) =>
    api(`/api/documents/${docId}/external-share/recipients/${recipientId}`, { method: 'DELETE' }));
}
export function usePublishExternalShare(docId: string) {
  return useInvalidating<{ versionId: string }>(docId, (body) =>
    api(`/api/documents/${docId}/external-share/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
}
