import { useQuery } from '@tanstack/react-query';
import type { MentionableUsersResponse, MentionableUser } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

export function useMentionableUsers() {
  return useQuery({
    queryKey: ['mentionable-users'],
    queryFn: async (): Promise<MentionableUser[]> => {
      const res = await api('/api/users/mentionable');
      if (!res.ok) throw new Error(`mentionable users fetch failed: ${res.status}`);
      const body = (await res.json()) as MentionableUsersResponse;
      return body.users;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
