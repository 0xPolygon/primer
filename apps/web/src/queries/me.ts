import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeResponse> => {
      const res = await api('/api/me');
      if (!res.ok) throw new Error(`me fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
