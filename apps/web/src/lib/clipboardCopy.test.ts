import { describe, it, expect, vi } from 'vitest';
import { copyText, type CopyAdapter } from './clipboardCopy.ts';

function makeAdapter(overrides: Partial<CopyAdapter> = {}): CopyAdapter {
  return {
    writeWithApi: overrides.writeWithApi ?? (() => Promise.reject(new Error('no api'))),
    writeWithFallback: overrides.writeWithFallback ?? (() => false),
  };
}

describe('copyText', () => {
  it('returns api on the happy path', async () => {
    const writeWithApi = vi.fn().mockResolvedValue(undefined);
    const result = await copyText('hello', makeAdapter({ writeWithApi }));
    expect(result).toBe('api');
    expect(writeWithApi).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand on api rejection', async () => {
    const writeWithApi = vi.fn().mockRejectedValue(new Error('denied'));
    const writeWithFallback = vi.fn().mockReturnValue(true);
    const result = await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(result).toBe('fallback');
    expect(writeWithFallback).toHaveBeenCalledWith('hello');
  });

  it('returns failed when both paths fail', async () => {
    const writeWithApi = vi.fn().mockRejectedValue(new Error('denied'));
    const writeWithFallback = vi.fn().mockReturnValue(false);
    const result = await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(result).toBe('failed');
  });

  it('does not call fallback when api succeeds', async () => {
    const writeWithApi = vi.fn().mockResolvedValue(undefined);
    const writeWithFallback = vi.fn().mockReturnValue(true);
    await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(writeWithFallback).not.toHaveBeenCalled();
  });
});
