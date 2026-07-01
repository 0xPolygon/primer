import { describe, it, expect } from 'vitest';
import { computePillPosition } from './computePillPosition.ts';

// Standard "lots of space everywhere" viewport. Tests override what they
// need to.
const VIEWPORT = { width: 1280, height: 800 };
const IFRAME = { left: 100, top: 60, width: 1000, height: 700 };
const PILL = { width: 220, height: 32 };

describe('computePillPosition', () => {
  it('places a single-line selection below the line with the configured gap', () => {
    const p = computePillPosition({
      rects: [{ x: 50, y: 200, width: 80, height: 18 }],
      iframeRect: IFRAME,
      pillSize: PILL,
      viewport: VIEWPORT,
      gap: 6,
    });
    expect(p).not.toBeNull();
    expect(p!.hidden).toBe(false);
    expect(p!.placement).toBe('below');
    // host-space left = iframe.left + rect.x = 100 + 50
    expect(p!.left).toBe(150);
    // host-space top = iframe.top + rect.y + rect.height + gap = 60 + 200 + 18 + 6
    expect(p!.top).toBe(284);
  });

  it('places a multi-line selection below the LAST line, not the first', () => {
    // Three-line selection spanning y=200..254 (line height 18, no gap).
    const p = computePillPosition({
      rects: [
        { x: 50, y: 200, width: 600, height: 18 },
        { x: 0, y: 218, width: 700, height: 18 },
        { x: 0, y: 236, width: 200, height: 18 },
      ],
      iframeRect: IFRAME,
      pillSize: PILL,
      viewport: VIEWPORT,
      gap: 6,
    });
    expect(p!.placement).toBe('below');
    // top = iframe.top + lastLine.y + lastLine.height + gap = 60 + 236 + 18 + 6
    expect(p!.top).toBe(320);
    // left = iframe.left + min(0, 50, 0) = 100
    expect(p!.left).toBe(100);
  });

  it('flips above the selection when there is no room below', () => {
    // Selection near the bottom of the host viewport. Iframe occupies the
    // full vertical region. With viewport=800, pill=32, gap=6, edgeMargin=8,
    // the flip threshold is bottom > 800 - 32 - 8 - 6 = 754. Selection
    // bottom = 760 + 18 = 778 > 754 → flip.
    const p = computePillPosition({
      rects: [{ x: 100, y: 760, width: 80, height: 18 }],
      iframeRect: { left: 0, top: 0, width: 1280, height: 800 },
      pillSize: PILL,
      viewport: VIEWPORT,
      gap: 6,
      edgeMargin: 8,
    });
    expect(p!.placement).toBe('above');
    // Above: top = selection.top - pillHeight - gap = 760 - 32 - 6 = 722
    expect(p!.top).toBe(722);
  });

  it('clamps "above" to edgeMargin when there is no room above either', () => {
    // Selection at very top of the host viewport with no room below (small
    // host) so the algorithm tries to flip above and then clamps.
    const p = computePillPosition({
      rects: [{ x: 100, y: 4, width: 80, height: 18 }],
      iframeRect: { left: 0, top: 0, width: 400, height: 60 },
      pillSize: PILL,
      viewport: { width: 400, height: 60 },
      gap: 6,
      edgeMargin: 8,
    });
    // No room below in a 60-tall viewport with a 32-tall pill; flip above
    // → 4 - 32 - 6 = -34 → clamped to edgeMargin 8.
    expect(p!.placement).toBe('above');
    expect(p!.top).toBe(8);
  });

  it('clamps the right edge so the pill never overflows the viewport', () => {
    // Selection starts near the right edge of the viewport.
    const p = computePillPosition({
      rects: [{ x: 1100, y: 200, width: 40, height: 18 }],
      iframeRect: { left: 100, top: 0, width: 1180, height: 800 },
      pillSize: PILL, // width 220
      viewport: VIEWPORT, // width 1280
      gap: 6,
      edgeMargin: 8,
    });
    // Without clamp: left = 100 + 1100 = 1200, right edge would be 1420
    // → overflows by 140. Clamp to 1280 - 220 - 8 = 1052.
    expect(p!.left).toBe(1052);
  });

  it('clamps the left edge so the pill never falls off the left side', () => {
    const p = computePillPosition({
      rects: [{ x: -50, y: 100, width: 30, height: 18 }],
      iframeRect: { left: -10, top: 0, width: 200, height: 800 },
      pillSize: PILL,
      viewport: { width: 1000, height: 800 },
      gap: 6,
      edgeMargin: 8,
    });
    // Without clamp: left = -10 + -50 = -60 → clamp to edgeMargin 8.
    expect(p!.left).toBe(8);
  });

  it('returns hidden when the entire selection is above the iframe band', () => {
    const p = computePillPosition({
      // Selection rendered above the iframe band (negative iframe-space y,
      // i.e. user scrolled the iframe content down).
      rects: [{ x: 100, y: -200, width: 80, height: 18 }],
      iframeRect: { left: 100, top: 60, width: 1000, height: 700 },
      pillSize: PILL,
      viewport: VIEWPORT,
    });
    expect(p!.hidden).toBe(true);
  });

  it('returns hidden when the entire selection is below the iframe band', () => {
    const p = computePillPosition({
      rects: [{ x: 100, y: 1200, width: 80, height: 18 }],
      iframeRect: { left: 100, top: 60, width: 1000, height: 700 },
      pillSize: PILL,
      viewport: VIEWPORT,
    });
    expect(p!.hidden).toBe(true);
  });

  it('clips selection to the iframe band when it straddles the bottom edge', () => {
    // Selection partially below the iframe band. Pill should anchor to
    // the clipped bottom (= iframe.top + iframe.height), not the
    // selection's true bottom (which is below the band).
    const p = computePillPosition({
      // Selection rect extends from y=650 to y=850 in iframe space.
      // iframe.height=700, so visible band ends at iframe-y=700.
      rects: [{ x: 50, y: 650, width: 80, height: 200 }],
      iframeRect: { left: 100, top: 60, width: 1000, height: 700 },
      pillSize: PILL,
      viewport: VIEWPORT,
      gap: 6,
    });
    expect(p!.hidden).toBe(false);
    // Clipped bottom in host space = iframe.top + iframe.height = 760.
    // top = 760 + gap = 766. But viewport.height=800, pillHeight=32,
    // edgeMargin=8 → roomBelow check: 766 + 32 + 8 = 806 > 800 → flip above.
    // Above: clippedTop = max(hostUnion.top=710, bandTop=60) = 710.
    // top = 710 - 32 - 6 = 672.
    expect(p!.placement).toBe('above');
    expect(p!.top).toBe(672);
  });

  it('returns null when given an empty rects array', () => {
    const p = computePillPosition({
      rects: [],
      iframeRect: IFRAME,
      pillSize: PILL,
      viewport: VIEWPORT,
    });
    expect(p).toBeNull();
  });
});
