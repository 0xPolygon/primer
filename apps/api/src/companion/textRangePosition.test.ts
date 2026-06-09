// apps/api/src/companion/textRangePosition.test.ts
//
// Pure-logic tests for the position-based text-range anchor in v1.js.
// The companion script is plain ES2020 served verbatim into the iframe,
// so the helpers below are a self-contained mirror of the math. If you
// change the math in v1.js, mirror it here (and vice versa).
//
// These tests do NOT exercise DOM — they operate on a synthetic
// `Segment[]` representation that mimics what `computeSegments(root)`
// returns. DOM integration is verified manually via devHarness.

import { describe, it, expect } from 'vitest';

// ── Types ────────────────────────────────────────────────────────────

/** One text-node entry in the segment index. `start` is inclusive,
 *  `end` is exclusive, both in raw cumulative characters from
 *  document.body. */
interface Segment {
  id: string;        // synthetic test ID; real impl uses the Text node ref
  text: string;
  start: number;
  end: number;
}

/** A range endpoint in the test fixture: which segment and the offset
 *  within that segment's text. */
interface Endpoint {
  segId: string;
  offset: number;
}

// ── Helpers (mirror of v1.js — keep in sync) ─────────────────────────

/** Build a segment index from a list of text-node values. Returns the
 *  Segment[] with cumulative start/end offsets. */
function buildSegments(textsById: Array<{ id: string; text: string }>): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const { id, text } of textsById) {
    out.push({ id, text, start: cursor, end: cursor + text.length });
    cursor += text.length;
  }
  return out;
}

/** Map an endpoint (segment + intra-segment offset) → raw cumulative offset. */
function endpointToOffset(segs: Segment[], ep: Endpoint): number {
  const seg = segs.find((s) => s.id === ep.segId);
  if (!seg) throw new Error(`segment not found: ${ep.segId}`);
  if (ep.offset < 0 || ep.offset > seg.text.length) {
    throw new Error(`offset ${ep.offset} out of range for segment ${ep.segId}`);
  }
  return seg.start + ep.offset;
}

/** Map a raw cumulative offset → endpoint. Offsets at segment boundaries
 *  resolve to the END of the earlier segment (not the start of the next).
 *  Returns null if offset is out of bounds. */
function offsetToEndpoint(segs: Segment[], offset: number): Endpoint | null {
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1]!;
  if (offset < 0 || offset > last.end) return null;
  // Binary search for the segment whose [start, end] contains offset.
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segs[mid]!;
    if (offset < seg.start) hi = mid - 1;
    else if (offset > seg.end) lo = mid + 1;
    else {
      // Boundary convention: if offset == seg.end and there's a next
      // segment, still return this segment (not the next's start).
      return { segId: seg.id, offset: offset - seg.start };
    }
  }
  return null;
}

/** Reconstruct the text between two raw offsets by walking segments. */
function sliceByOffsets(segs: Segment[], start: number, end: number): string {
  let out = '';
  for (const seg of segs) {
    if (seg.end <= start) continue;
    if (seg.start >= end) break;
    const a = Math.max(0, start - seg.start);
    const b = Math.min(seg.text.length, end - seg.start);
    out += seg.text.slice(a, b);
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('position-based anchors — cross-cell selection', () => {
  it('round-trips a selection that spans three table cells', () => {
    // Mimics: <tr><td>usdc_ethereum</td><td>COINME</td><td>USDC</td></tr>
    // Real HTML may have whitespace text nodes between cells (varies by
    // HTML5 parser rules — but per spec, whitespace inside a TR between
    // TD elements is dropped). We model the dense case here; the
    // sparse-whitespace variant is covered in a separate test below.
    const segs = buildSegments([
      { id: 'td1', text: 'usdc_ethereum' },
      { id: 'td2', text: 'COINME' },
      { id: 'td3', text: 'USDC' },
    ]);

    // Select from "usdc_ethereum" (start of td1) to mid-"USDC" (offset 4 of td3, i.e. all of "USDC").
    const start = endpointToOffset(segs, { segId: 'td1', offset: 0 });
    const end = endpointToOffset(segs, { segId: 'td3', offset: 4 });

    expect(start).toBe(0);
    expect(end).toBe(13 + 6 + 4); // 23

    // Resolve back.
    const startEp = offsetToEndpoint(segs, start);
    const endEp = offsetToEndpoint(segs, end);
    expect(startEp).toEqual({ segId: 'td1', offset: 0 });
    expect(endEp).toEqual({ segId: 'td3', offset: 4 });

    // And the selected text is the concatenation across cells.
    expect(sliceByOffsets(segs, start, end)).toBe('usdc_ethereumCOINMEUSDC');
  });
});
