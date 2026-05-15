import { describe, it, expect } from 'vitest';
import { parseInboundMessage } from '@primer/shared';

describe('parseInboundMessage', () => {
  it('round-trips selection_captured', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'hello',
        prefix: 'before-',
        suffix: '-after',
        containerPath: 'body > p:nth-of-type(1)',
      },
      clientRects: [{ x: 1, y: 2, width: 3, height: 4 }],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips element_picked', () => {
    const ok = {
      type: 'element_picked',
      anchor: {
        type: 'element-path',
        path: 'body > div:nth-of-type(1) > canvas:nth-of-type(1)',
        innerHash: '0123456789abcdef',
      },
      clientRect: { x: 10, y: 20, width: 200, height: 80 },
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips pick_mode_exited', () => {
    expect(parseInboundMessage({ type: 'pick_mode_exited' })).toEqual({
      type: 'pick_mode_exited',
    });
  });

  it('round-trips anchor_positions including drifted entries', () => {
    const ok = {
      type: 'anchor_positions',
      positions: [
        { anchorId: 'a1', rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { anchorId: 'a2', rects: [], drifted: true },
      ],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips resize', () => {
    expect(parseInboundMessage({ type: 'resize', height: 768 })).toEqual({
      type: 'resize',
      height: 768,
    });
  });

  it('round-trips open_external', () => {
    expect(parseInboundMessage({ type: 'open_external', url: 'https://example.com' })).toEqual({
      type: 'open_external',
      url: 'https://example.com',
    });
  });

  it('returns null for missing type', () => {
    expect(parseInboundMessage({ foo: 'bar' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseInboundMessage({ type: 'nope' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseInboundMessage('hello')).toBeNull();
    expect(parseInboundMessage(null)).toBeNull();
    expect(parseInboundMessage(undefined)).toBeNull();
    expect(parseInboundMessage(42)).toBeNull();
  });

  it('returns null for selection_captured with malformed anchor', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'x' /* missing prefix/suffix/containerPath */ },
        clientRects: [],
      })
    ).toBeNull();
  });
});
