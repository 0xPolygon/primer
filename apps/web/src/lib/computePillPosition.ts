import type { SerializableRect } from '@primer/shared';

export interface ComputePillPositionArgs {
  // Selection client rects in iframe-viewport space (what the companion
  // emits — one rect per visual line of the selection).
  rects: SerializableRect[];
  // Iframe's bounding rect in host-viewport space.
  iframeRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  // Measured pill size (offsetWidth/offsetHeight). On the first paint
  // the caller should pass a conservative fallback; we re-measure after
  // layout.
  pillSize: { width: number; height: number };
  // Host window viewport size (innerWidth/innerHeight).
  viewport: { width: number; height: number };
  // Vertical gap between pill and selection. Default 6.
  gap?: number;
  // Minimum margin to viewport edges. Default 8.
  edgeMargin?: number;
}

export interface PillPosition {
  // host-viewport-space coords for position:fixed
  left: number;
  top: number;
  placement: 'below' | 'above';
  // True when the selection is fully outside the iframe's visible band.
  // Caller should suppress rendering (or render with visibility:hidden).
  hidden: boolean;
}

interface UnionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function unionOf(rects: SerializableRect[]): UnionRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.x < left) left = r.x;
    if (r.x + r.width > right) right = r.x + r.width;
    if (r.y < top) top = r.y;
    if (r.y + r.height > bottom) bottom = r.y + r.height;
  }
  return { left, top, right, bottom };
}

export function computePillPosition(
  args: ComputePillPositionArgs
): PillPosition | null {
  const { rects, iframeRect, pillSize, viewport } = args;
  const gap = args.gap ?? 6;
  const edgeMargin = args.edgeMargin ?? 8;

  const iframeUnion = unionOf(rects);
  if (!iframeUnion) return null;

  // Translate the union into host-viewport space and clip to the iframe's
  // visible band. If the clipped band is empty (selection scrolled fully
  // out of view), report hidden.
  const hostUnion: UnionRect = {
    left: iframeUnion.left + iframeRect.left,
    right: iframeUnion.right + iframeRect.left,
    top: iframeUnion.top + iframeRect.top,
    bottom: iframeUnion.bottom + iframeRect.top,
  };
  const bandTop = iframeRect.top;
  const bandBottom = iframeRect.top + iframeRect.height;
  const clippedTop = Math.max(hostUnion.top, bandTop);
  const clippedBottom = Math.min(hostUnion.bottom, bandBottom);
  if (clippedBottom <= clippedTop) {
    // Entire selection is above or below the iframe's visible band.
    return {
      left: 0,
      top: 0,
      placement: 'below',
      hidden: true,
    };
  }
  const clipped: UnionRect = {
    left: hostUnion.left,
    right: hostUnion.right,
    top: clippedTop,
    bottom: clippedBottom,
  };

  // Vertical: try below first; flip above when no room.
  const belowTop = clipped.bottom + gap;
  const roomBelow = belowTop + pillSize.height + edgeMargin <= viewport.height;
  let placement: 'below' | 'above';
  let top: number;
  if (roomBelow) {
    placement = 'below';
    top = belowTop;
  } else {
    placement = 'above';
    top = clipped.top - pillSize.height - gap;
    // If even "above" overflows the top, clamp to edgeMargin so the
    // pill at least stays on-screen rather than disappearing.
    if (top < edgeMargin) top = edgeMargin;
  }

  // Horizontal: align with selection's left edge, clamped to viewport.
  let left = clipped.left;
  const maxLeft = viewport.width - pillSize.width - edgeMargin;
  if (left > maxLeft) left = maxLeft;
  if (left < edgeMargin) left = edgeMargin;

  return { left, top, placement, hidden: false };
}
