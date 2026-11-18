import { describe, it, expect, vi } from 'vitest';
import {
  copyDeferredText,
  copyText,
  type CopyAdapter,
  type DeferredCopyAdapter,
} from './clipboardCopy.ts';

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

describe('copyDeferredText', () => {
  function makeDeferred(overrides: Partial<DeferredCopyAdapter> = {}): DeferredCopyAdapter {
    return {
      writeDeferred: overrides.writeDeferred,
      copyNow: overrides.copyNow ?? vi.fn().mockResolvedValue('api'),
    };
  }

  it('hands the pending text to the clipboard before it resolves', () => {
    const writeDeferred = vi.fn().mockResolvedValue(undefined);
    const pending = new Promise<string>(() => {});
    void copyDeferredText(pending, makeDeferred({ writeDeferred }));
    // Called synchronously, i.e. still inside the user's click.
    expect(writeDeferred).toHaveBeenCalledWith(pending);
  });

  it('returns api without copying again when the deferred write succeeds', async () => {
    const writeDeferred = vi.fn().mockResolvedValue(undefined);
    const copyNow = vi.fn();
    const result = await copyDeferredText(
      Promise.resolve('hello'),
      makeDeferred({ writeDeferred, copyNow }),
    );
    expect(result).toBe('api');
    expect(copyNow).not.toHaveBeenCalled();
  });

  it('copies the resolved text when the deferred write is refused', async () => {
    const writeDeferred = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const copyNow = vi.fn().mockResolvedValue('fallback');
    const result = await copyDeferredText(
      Promise.resolve('hello'),
      makeDeferred({ writeDeferred, copyNow }),
    );
    expect(result).toBe('fallback');
    expect(copyNow).toHaveBeenCalledWith('hello');
  });

  it('copies the resolved text where deferred writes are unsupported', async () => {
    const copyNow = vi.fn().mockResolvedValue('api');
    await copyDeferredText(Promise.resolve('hello'), makeDeferred({ copyNow }));
    expect(copyNow).toHaveBeenCalledWith('hello');
  });

  it('rejects when the text itself fails to load', async () => {
    const writeDeferred = (t: Promise<string>) => t.then(() => undefined);
    await expect(
      copyDeferredText(Promise.reject(new Error('HTTP 500')), makeDeferred({ writeDeferred })),
    ).rejects.toThrow('HTTP 500');
  });
});
