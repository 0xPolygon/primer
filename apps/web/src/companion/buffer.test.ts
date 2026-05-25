import { describe, it, expect, vi } from 'vitest';
import { createMessageBuffer } from './buffer.ts';

describe('createMessageBuffer', () => {
  it('reports zero size when empty', () => {
    const buf = createMessageBuffer<number>(10);
    expect(buf.size()).toBe(0);
  });

  it('enqueues up to cap', () => {
    const buf = createMessageBuffer<number>(3);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    expect(buf.size()).toBe(3);
  });

  it('drops the oldest entry when over cap', () => {
    const buf = createMessageBuffer<number>(2);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    expect(buf.size()).toBe(2);
    const sink = vi.fn();
    buf.drain(sink);
    expect(sink.mock.calls.map((c) => c[0])).toEqual([2, 3]);
  });

  it('drains in FIFO order and empties the buffer', () => {
    const buf = createMessageBuffer<string>(5);
    buf.enqueue('a');
    buf.enqueue('b');
    buf.enqueue('c');
    const sink = vi.fn();
    buf.drain(sink);
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(buf.size()).toBe(0);
  });

  it('is safe to drain twice (second drain is a no-op)', () => {
    const buf = createMessageBuffer<number>(5);
    buf.enqueue(1);
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    buf.drain(sink1);
    buf.drain(sink2);
    expect(sink1).toHaveBeenCalledTimes(1);
    expect(sink2).not.toHaveBeenCalled();
  });

  it('stops draining if the sink throws, preserving remaining entries', () => {
    const buf = createMessageBuffer<number>(5);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    const sink = vi.fn((n: number) => {
      if (n === 2) throw new Error('sink failed');
    });
    expect(() => buf.drain(sink)).toThrow('sink failed');
    expect(buf.size()).toBe(1);
    const survivor = vi.fn();
    buf.drain(survivor);
    expect(survivor.mock.calls.map((c) => c[0])).toEqual([3]);
  });
});
