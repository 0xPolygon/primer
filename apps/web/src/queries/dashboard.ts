import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useDashboardQuery() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async ({ signal }): Promise<DashboardResponse> => {
      const res = await api('/api/dashboard', { signal });
      if (!res.ok) throw new Error(`dashboard fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
