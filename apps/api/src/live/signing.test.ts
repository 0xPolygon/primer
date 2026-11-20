import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '../storage/types.ts';

describe('ensureSigningKey', () => {
  it('makes the key only when it is missing, never on another storage failure', async () => {
    const { ensureSigningKey } = await import('./signing.ts');
    const put = vi.fn(async () => undefined);
    const down: Storage = {
      get: async () => {
        throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      },
      put,
      delete: async () => undefined,
    };
    await expect(ensureSigningKey(down)).rejects.toThrow('storage unavailable');
    expect(put).not.toHaveBeenCalled();

    const missing: Storage = {
      get: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      put,
      delete: async () => undefined,
    };
    await ensureSigningKey(missing);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
