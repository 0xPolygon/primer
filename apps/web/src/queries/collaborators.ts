import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Collaborator,
  CollaboratorsListResponse,
  UserSearchResponse,
} from '@primer/shared/api';
import { api } from '../lib/fetch.ts';

type CollaboratorRole = 'commenter' | 'editor';

export function useCollaborators(docId: string) {
  return useQuery({
    queryKey: ['collaborators', docId],
    queryFn: async (): Promise<Collaborator[]> => {
      const res = await api(`/api/documents/${docId}/collaborators`);
      if (!res.ok) throw new Error(`collaborators fetch failed: ${res.status}`);
      const body = (await res.json()) as CollaboratorsListResponse;
      return body.collaborators;
    },
  });
}

export function useUserSearch(q: string, docId: string | null) {
  return useQuery({
    queryKey: ['user-search', q, docId],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('q', q);
      if (docId) params.set('docId', docId);
      const res = await api(`/api/users?${params.toString()}`);
      if (!res.ok) throw new Error(`user search failed: ${res.status}`);
      const body = (await res.json()) as UserSearchResponse;
      return body.users;
    },
    enabled: q.length > 0,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useAddCollaborator(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: CollaboratorRole }): Promise<Collaborator> => {
      const res = await api(`/api/documents/${docId}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`add collaborator failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useUpdateCollaboratorRole(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: CollaboratorRole }): Promise<Collaborator> => {
      const res = await api(`/api/documents/${docId}/collaborators/${input.userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: input.role }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`update collaborator failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useRemoveCollaborator(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string): Promise<void> => {
      const res = await api(`/api/documents/${docId}/collaborators/${userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`remove collaborator failed: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
    },
  });
}

export function useSetVisibility(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (visibility: 'org' | 'private') => {
      const res = await api(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`set visibility failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['collaborators', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}
