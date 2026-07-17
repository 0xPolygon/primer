import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiTokensListResponse,
  CreateTokenRequest,
  CreateTokenResponse,
} from '@primer/shared/api';
import { api } from '../lib/fetch.ts';

async function createToken(path: string, name: string): Promise<CreateTokenResponse> {
  const body: CreateTokenRequest = { name };
  const res = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`create failed: ${res.status} ${text}`);
  }
  return (await res.json()) as CreateTokenResponse;
}

async function revokeToken(path: string): Promise<void> {
  const res = await api(path, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`revoke failed: ${res.status} ${text}`);
  }
}

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

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createToken('/api/tokens', name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeToken(`/api/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}

// Service-account (Claude) tokens — admin only. Pass `enabled: me.isAdmin`
// so non-admins never fire a request that would 403.
export function useServiceTokens(enabled: boolean) {
  return useQuery({
    queryKey: ['service-tokens'],
    queryFn: async (): Promise<ApiTokensListResponse> => {
      const res = await api('/api/service-tokens');
      if (!res.ok) throw new Error(`service tokens fetch failed: ${res.status}`);
      return (await res.json()) as ApiTokensListResponse;
    },
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useCreateServiceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createToken('/api/service-tokens', name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-tokens'] });
    },
  });
}

export function useRevokeServiceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeToken(`/api/service-tokens/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-tokens'] });
    },
  });
}
