/** Fit-to-width scaling math for the artifact iframe on narrow screens.
 *
 * The companion reports the artifact's intrinsic content width when it
 * overflows the iframe viewport (see companion/v1.js reportContentMetrics
 * and MsgContentMetrics in @primer/shared). The parent converts that into
 * a CSS transform scale. All decision logic lives here as pure functions
 * so the node-environment test suite covers it. */

export const FIT_SCALE_FLOOR = 0.5;

/** Content must exceed the container by >2% before fit-to-width engages —
 * sub-pixel rounding and scrollbar noise must not trigger a zoom-out.
 * Mirrored as a literal in the companion's reporting guard; keep in sync. */
export const FIT_OVERFLOW_TOLERANCE = 1.02;

/** Widest content width (px) the companion has reported for the current
 * document version. Null = render 1:1. */
export type FitState = { contentWidth: number } | null;

/** Grow-only accumulator: reports never shrink the layout width, which
 * prevents reflow→re-measure oscillation (widening the iframe reflows the
 * content, which fires a new measurement). The caller resets the state on
 * src change; rotation is handled by computeFitScale reading the live
 * container width. */
export function nextFitState(
  current: FitState,
  reportedContentWidth: number,
  containerWidth: number,
): FitState {
  if (!Number.isFinite(reportedContentWidth) || reportedContentWidth <= 0) return current;
  if (containerWidth > 0 && reportedContentWidth <= containerWidth * FIT_OVERFLOW_TOLERANCE) {
    return current;
  }
  if (current && reportedContentWidth <= current.contentWidth) return current;
  return { contentWidth: reportedContentWidth };
}

export function computeFitScale(state: FitState, containerWidth: number): number {
  if (!state || containerWidth <= 0) return 1;
  if (containerWidth * FIT_OVERFLOW_TOLERANCE >= state.contentWidth) return 1;
  return Math.max(FIT_SCALE_FLOOR, Math.min(1, containerWidth / state.contentWidth));
}

/** Inline styles for the iframe. At scale 1 the iframe naturally fills its
 * wrapper; below 1 it lays out at the content's intrinsic width and is
 * transform-scaled back down to fit. Height compensates (100/scale %) so
 * the scaled result still fills the wrapper vertically. */
export function fitIframeStyle(
  scale: number,
  state: FitState,
): { width: string; height: string; transform?: string; transformOrigin?: string } {
  if (scale >= 1 || !state) return { width: '100%', height: '100%' };
  return {
    width: `${state.contentWidth}px`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
  };
}

/** True when even the floored scale cannot fit the content — the wrapper
 * must then allow horizontal panning instead of clipping. */
export function hasResidualOverflow(
  scale: number,
  state: FitState,
  containerWidth: number,
): boolean {
  if (!state || scale >= 1) return false;
  return state.contentWidth * scale > containerWidth + 1;
}
