import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@primer/shared';

export function useDashboardQuery() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async ({ signal }): Promise<DashboardResponse> => {
      const res = await fetch('/api/dashboard', { signal });
      if (!res.ok) throw new Error(`dashboard fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
