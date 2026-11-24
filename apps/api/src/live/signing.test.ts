import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '../storage/types.ts';

describe('loadSigningKey', () => {
  it('makes the key only when it is missing, never on another storage failure', async () => {
    const { loadSigningKey } = await import('./signing.ts');
    const put = vi.fn(async () => undefined);
    const putIfAbsent = vi.fn(async () => true);
    const down: Storage = {
      get: async () => {
        throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      },
      put,
      putIfAbsent,
      delete: async () => undefined,
    };
    await expect(loadSigningKey(down)).rejects.toThrow('storage unavailable');
    expect(putIfAbsent).not.toHaveBeenCalled();

    const missing: Storage = {
      get: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      put,
      putIfAbsent,
      delete: async () => undefined,
    };
    await loadSigningKey(missing);
    expect(putIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('two starters racing on first boot end with the same key', async () => {
    const objects = new Map<string, Buffer>();
    const racing = (): Storage => ({
      get: async (k) => {
        const v = objects.get(k);
        if (!v) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return new Response(new Uint8Array(v)).body!;
      },
      put: async () => undefined,
      // Both starters see "missing" before either writes.
      putIfAbsent: async (k, b) => {
        await new Promise((r) => setTimeout(r, 5));
        if (objects.has(k)) return false;
        objects.set(k, Buffer.from(b));
        return true;
      },
      delete: async () => undefined,
    });
    // Each starter is its own process: its own module state.
    const starter = async () => {
      vi.resetModules();
      const signing = await import('./signing.ts');
      return signing;
    };
    const [a, b] = [await starter(), await starter()];
    await Promise.all([a.loadSigningKey(racing()), b.loadSigningKey(racing())]);
    expect(objects.size).toBe(1);
    const stored = objects.get('keys/live-import-hmac')!;
    const expected = createHmac('sha256', stored).update(JSON.stringify(['d', 1])).digest('hex');
    expect(a.sign('d', [1])).toBe(expected);
    expect(b.sign('d', [1])).toBe(expected);
  });
});
