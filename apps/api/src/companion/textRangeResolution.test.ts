// Pure-logic tests for the text-range anchor resolution math in
// apps/api/src/companion/v1.js. The companion script is plain ES2020 JS
// served verbatim into the iframe — there's no module loader, so the
// helpers below are a self-contained copy of the math from v1.js. If you
// change the math in v1.js, mirror it here (and vice versa).
//
// NOTE: This file deliberately *starts* mirroring v1.js's buggy
// trim-based normalization to demonstrate the failing-test stage of TDD.
// The helpers and v1.js are updated together in the same change.

import { describe, it, expect } from 'vitest';

// ── Helpers (mirror of v1.js) ────────────────────────────────────────

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function mapNormalizedToRaw(raw: string, normalizedOffset: number): number {
  let i = 0;
  // Skip leading whitespace that normalize() strips, so offset 0 lands on
  // the first visible character.
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  let nIdx = 0;
  while (i < raw.length && nIdx < normalizedOffset) {
    if (/\s/.test(raw[i]!)) {
      // Consume the entire whitespace run; it contributes one normalized
      // char. Leaves i positioned at the next non-WS character (or end).
      while (i < raw.length && /\s/.test(raw[i]!)) i++;
      nIdx++;
    } else {
      i++;
      nIdx++;
    }
  }
  return nIdx === normalizedOffset ? i : -1;
}

interface TextRangeAnchorFields {
  prefix: string;
  selectorText: string;
  suffix: string;
}

interface Offsets {
  rawStart: number;
  rawEnd: number;
}

/** Given the raw text of the container and the anchor's text-range fields,
 *  return { rawStart, rawEnd } (offsets into `raw`) or null. */
function findTextRangeOffsets(
  raw: string,
  anchor: TextRangeAnchorFields,
): Offsets | null {
  const normalizedRaw = normalize(raw);
  const cPrefix = collapseWhitespace(anchor.prefix);
  const cSelector = collapseWhitespace(anchor.selectorText);
  const cSuffix = collapseWhitespace(anchor.suffix);
  const cFull = cPrefix + cSelector + cSuffix;
  // Trim outer ends to align with normalizedRaw, which is fully-normalized.
  const needle = cFull.replace(/^\s+|\s+$/g, '');
  const hit = normalizedRaw.indexOf(needle);
  if (hit === -1) return null;

  // If the full collapsed string had leading whitespace that got trimmed
  // from the needle, the selector's position inside the needle shifts
  // left by that amount.
  const leadingTrim = cFull.length - cFull.replace(/^\s+/, '').length;
  const selStart = Math.max(0, cPrefix.length - leadingTrim);

  const rawStart = mapNormalizedToRaw(raw, hit + selStart);
  const rawEnd = mapNormalizedToRaw(raw, hit + selStart + cSelector.length);
  if (rawStart < 0 || rawEnd < 0) return null;
  return { rawStart, rawEnd };
}

// ── Capture helper (the contextual prefix/suffix builder). ───────────
//
// This is the pure-string portion of v1.js's `collectContext`. The real
// function walks the DOM to assemble `beforeRaw`/`afterRaw`; here we
// take them as inputs. n=32 matches the production cap.

function buildContext(
  beforeRaw: string,
  afterRaw: string,
  n = 32,
): { prefix: string; suffix: string } {
  return {
    prefix: collapseWhitespace(beforeRaw).slice(-n),
    suffix: collapseWhitespace(afterRaw).slice(0, n),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('findTextRangeOffsets — round-trip via buildContext', () => {
  // Helper: simulate a selection at character offsets [start, end) inside
  // a single text-node container. Returns the anchor fields the companion
  // would store, then resolves them back against the same raw text.
  function roundTrip(raw: string, start: number, end: number): Offsets | null {
    const beforeRaw = raw.slice(0, start);
    const afterRaw = raw.slice(end);
    const selectorText = raw.slice(start, end);
    const { prefix, suffix } = buildContext(beforeRaw, afterRaw);
    return findTextRangeOffsets(raw, { prefix, selectorText, suffix });
  }

  it('resolves a double-clicked word in the middle of a paragraph', () => {
    // "Hello World friend" — select "World" at [6, 11)
    const raw = 'Hello World friend';
    const result = roundTrip(raw, 6, 11);
    expect(result).not.toBeNull();
    expect(result).toEqual({ rawStart: 6, rawEnd: 11 });
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('World');
  });

  it('resolves a word at the start of the container', () => {
    const raw = 'World friend';
    const result = roundTrip(raw, 0, 5);
    expect(result).not.toBeNull();
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('World');
  });

  it('resolves a word at the end of the container', () => {
    const raw = 'Hello World';
    const result = roundTrip(raw, 6, 11);
    expect(result).not.toBeNull();
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('World');
  });

  it('resolves a multi-word phrase that ends on a word boundary', () => {
    const raw = 'Hello World friend';
    const result = roundTrip(raw, 0, 11); // "Hello World"
    expect(result).not.toBeNull();
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('Hello World');
  });

  it('resolves selector across runs of whitespace in the raw text', () => {
    // Raw has multiple spaces / newlines (simulating prettified HTML);
    // selectorText is just "World".
    const raw = 'Hello   World\n  friend';
    // Position of "World" in raw is 8..13
    const result = roundTrip(raw, 8, 13);
    expect(result).not.toBeNull();
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('World');
  });

  it('resolves a word in a container with leading whitespace (indented HTML)', () => {
    const raw = '   Hello World';
    // "Hello" at [3, 8)
    const result = roundTrip(raw, 3, 8);
    expect(result).not.toBeNull();
    expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe('Hello');
  });

  it('returns null when the selector and context do not appear in raw', () => {
    const result = findTextRangeOffsets('Lorem ipsum', {
      prefix: 'Hello ',
      selectorText: 'World',
      suffix: ' friend',
    });
    expect(result).toBeNull();
  });
});

describe('findTextRangeOffsets — invariants', () => {
  it('always returns a range that slices to the original selector', () => {
    const raw = 'The quick brown fox jumps over the lazy dog';
    // Walk every word and verify round-trip
    let i = 0;
    while (i < raw.length) {
      // skip leading non-letters
      while (i < raw.length && !/[a-z]/i.test(raw[i]!)) i++;
      const start = i;
      while (i < raw.length && /[a-z]/i.test(raw[i]!)) i++;
      const end = i;
      if (end <= start) break;
      const expected = raw.slice(start, end);
      const before = raw.slice(0, start);
      const after = raw.slice(end);
      const { prefix, suffix } = buildContext(before, after);
      const result = findTextRangeOffsets(raw, { prefix, selectorText: expected, suffix });
      expect(result, `word "${expected}" at [${start}, ${end})`).not.toBeNull();
      expect(raw.slice(result!.rawStart, result!.rawEnd)).toBe(expected);
    }
  });
});
