import { useMutation, useQuery } from '@tanstack/react-query';
import type { DeviceApproveResponse, DevicePendingResponse } from '@primer/shared/api';
import { api } from '../lib/fetch.ts';

/**
 * `XXXX-XXXX` from the server alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` —
 * no `0`/`1`/`O`/`I` (avoids look-alike confusion when the user types from
 * terminal). The server in `apps/api/src/auth/tokens.ts` is the source of
 * truth; this client regex mirrors it so a typo like `O` vs `0` is rejected
 * locally with a clear "format" hint rather than round-tripped into a 404.
 */
const USER_CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export function isValidUserCode(userCode: string): boolean {
  return USER_CODE_REGEX.test(userCode);
}

export class DevicePendingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'DevicePendingError';
  }
}

export function useDevicePending(userCode: string) {
  return useQuery({
    queryKey: ['device-pending', userCode],
    enabled: isValidUserCode(userCode),
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<DevicePendingResponse> => {
      const res = await api(`/api/device/pending?userCode=${encodeURIComponent(userCode)}`);
      if (!res.ok) {
        throw new DevicePendingError(res.status, `device pending failed: ${res.status}`);
      }
      return (await res.json()) as DevicePendingResponse;
    },
  });
}

export function useApproveDevice() {
  return useMutation({
    mutationFn: async (userCode: string): Promise<DeviceApproveResponse> => {
      const res = await api('/api/device/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`approve failed: ${res.status} ${text}`);
      }
      return (await res.json()) as DeviceApproveResponse;
    },
  });
}

export function useDenyDevice() {
  return useMutation({
    mutationFn: async (userCode: string): Promise<void> => {
      const res = await api('/api/device/deny', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`deny failed: ${res.status} ${text}`);
      }
    },
  });
}
