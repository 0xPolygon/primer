import { describe, it, expect } from 'vitest';

// Mirrored from the reporting guard in companion/v1.js
// (reportContentMetrics); keep in sync. The companion is a plain-JS IIFE,
// so the decision logic is mirrored here rather than imported — same
// pattern as mermaidScanner.test.ts.
function shouldReportContentWidth(
  contentWidth: number,
  clientWidth: number,
  lastReported: number,
): boolean {
  if (!(contentWidth > 0) || !(clientWidth > 0)) return false;
  if (contentWidth <= clientWidth * 1.02) return false;
  if (contentWidth === lastReported) return false;
  return true;
}

describe('companion content-metrics reporting guard (mirror)', () => {
  it('does not report content that fits', () => {
    expect(shouldReportContentWidth(390, 390, 0)).toBe(false);
  });

  it('does not report within the 2% tolerance', () => {
    expect(shouldReportContentWidth(397, 390, 0)).toBe(false); // 390*1.02 = 397.8
  });

  it('reports genuine overflow', () => {
    expect(shouldReportContentWidth(800, 390, 0)).toBe(true);
  });

  it('suppresses duplicate reports of the same width', () => {
    expect(shouldReportContentWidth(800, 390, 800)).toBe(false);
  });

  it('reports again when content grows past the last report', () => {
    expect(shouldReportContentWidth(1000, 800, 800)).toBe(true); // overflows 800*1.02=816 and differs from last report
  });

  it('rejects degenerate measurements', () => {
    expect(shouldReportContentWidth(0, 390, 0)).toBe(false);
    expect(shouldReportContentWidth(800, 0, 0)).toBe(false);
  });
});
