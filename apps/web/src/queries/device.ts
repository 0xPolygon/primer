import { useMutation, useQuery } from '@tanstack/react-query';
import type { DeviceApproveResponse, DevicePendingResponse } from '@primer/shared/api';
import { api } from '../lib/fetch.ts';

/**
 * `XXXX-XXXX` where each X is a character from [A-Z2-9]. The server generates
 * codes in this exact shape (no `0`/`1`/`O`/`I` to avoid look-alike confusion).
 */
const USER_CODE_REGEX = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

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
