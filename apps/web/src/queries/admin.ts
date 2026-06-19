import { useQuery } from '@tanstack/react-query';
import type { AdminStatsResponse } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: async ({ signal }): Promise<AdminStatsResponse> => {
      const res = await api('/api/admin/stats', { signal });
      if (!res.ok) throw new Error(`admin stats fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
}
