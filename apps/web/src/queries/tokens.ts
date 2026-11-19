import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentsListResponse,
  ApiTokensListResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateTokenRequest,
  CreateTokenResponse,
} from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

async function createToken(path: string, body: CreateTokenRequest): Promise<CreateTokenResponse> {
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
    mutationFn: (req: CreateTokenRequest) => createToken('/api/tokens', req),
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

// Agents: identities the signed-in person creates; each acts via them with
// its own scoped tokens (GET/POST /api/agents, /api/agents/:id/tokens).
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: async (): Promise<AgentsListResponse> => {
      const res = await api('/api/agents');
      if (!res.ok) throw new Error(`agents fetch failed: ${res.status}`);
      return (await res.json()) as AgentsListResponse;
    },
    refetchOnWindowFocus: false,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: CreateAgentRequest): Promise<CreateAgentResponse> => {
      const res = await api('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`create failed: ${res.status} ${text}`);
      }
      return (await res.json()) as CreateAgentResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useCreateAgentToken(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateTokenRequest) =>
      createToken(`/api/agents/${encodeURIComponent(agentId)}/tokens`, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useRevokeAgentToken(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      revokeToken(`/api/agents/${encodeURIComponent(agentId)}/tokens/${encodeURIComponent(tokenId)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
