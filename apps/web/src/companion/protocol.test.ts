import { describe, it, expect } from 'vitest';
import { parseInboundMessage, parseWindowEnvelope } from '@primer/shared';

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

  it('accepts selection_captured with position-based anchor', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        start: 100,
        end: 111,
      },
      clientRects: [{ x: 0, y: 0, width: 10, height: 10 }],
    };
    const parsed = parseInboundMessage(ok);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('selection_captured');
  });

  it('accepts selection_captured with legacy text-context anchor', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        prefix: 'before ',
        suffix: ' after',
        containerPath: 'body > article > p',
      },
      clientRects: [],
    };
    const parsed = parseInboundMessage(ok);
    expect(parsed).not.toBeNull();
  });

  it('rejects text-range anchor with neither position nor legacy shape', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'just text' },
        clientRects: [],
      })
    ).toBeNull();
  });

  it('rejects text-range anchor with only `start`, no `end`', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'x', start: 5 },
        clientRects: [],
      })
    ).toBeNull();
  });
});

describe('parseInboundMessage — companion_log', () => {
  it('round-trips info level', () => {
    const ok = { type: 'companion_log', level: 'info', message: 'hello world' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips warn level', () => {
    const ok = { type: 'companion_log', level: 'warn', message: 'CSS Highlight API missing' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips error level', () => {
    const ok = { type: 'companion_log', level: 'error', message: 'boom' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('rejects companion_log with unknown level', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'debug', message: 'x' })
    ).toBeNull();
  });

  it('rejects companion_log without message string', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'info', message: 42 })
    ).toBeNull();
  });
});

describe('parseWindowEnvelope', () => {
  it('parses companion_ready', () => {
    expect(parseWindowEnvelope({ type: 'companion_ready', v: 1 })).toEqual({
      type: 'companion_ready',
    });
  });

  it('parses companion_panic with reason', () => {
    expect(
      parseWindowEnvelope({ type: 'companion_panic', reason: 'init exhausted' })
    ).toEqual({ type: 'companion_panic', reason: 'init exhausted' });
  });

  it('returns null for unknown type', () => {
    expect(parseWindowEnvelope({ type: 'something_else' })).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseWindowEnvelope({ foo: 'bar' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseWindowEnvelope(null)).toBeNull();
    expect(parseWindowEnvelope(undefined)).toBeNull();
    expect(parseWindowEnvelope('hi')).toBeNull();
  });

  it('returns null for companion_panic without reason string', () => {
    expect(parseWindowEnvelope({ type: 'companion_panic', reason: 42 })).toBeNull();
  });
});
