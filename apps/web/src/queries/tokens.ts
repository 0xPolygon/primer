import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiTokensListResponse } from '@primer/shared/api';
import { api } from '../lib/fetch.ts';

export function useApiTokens() {
  return useQuery({
    queryKey: ['tokens'],
    queryFn: async (): Promise<ApiTokensListResponse> => {
      const res = await api('/api/tokens');
      if (!res.ok) throw new Error(`tokens fetch failed: ${res.status}`);
      return (await res.json()) as ApiTokensListResponse;
    },
    refetchOnWindowFocus: false,
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await api(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`revoke failed: ${res.status} ${text}`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}
