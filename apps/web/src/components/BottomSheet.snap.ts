export type SnapPoint = 'handle' | 'peek' | 'expanded';

export interface SnapDef {
  name: SnapPoint;
  /** Sheet height (px) at this snap. Heights must be unique. */
  height: number;
}

export interface ResolveInput {
  /** Sheet height (px) at the moment of release. */
  currentHeight: number;
  /** px/ms — positive = sheet shrinking (drag-down), negative = growing. */
  velocity: number;
  /** All available snaps. Order doesn't matter; we sort internally. */
  snaps: SnapDef[];
  /** |velocity| above this picks direction-based snap; below = nearest. */
  velocityThreshold?: number;
}

export function resolveSnap({
  currentHeight,
  velocity,
  snaps,
  velocityThreshold = 0.5,
}: ResolveInput): SnapPoint {
  const ascending = [...snaps].sort((a, b) => a.height - b.height);

  if (velocity > velocityThreshold) {
    // Sheet shrinking — pick the next snap strictly below current height.
    const below = [...ascending].reverse().find((s) => s.height < currentHeight);
    return (below ?? ascending[0]).name;
  }
  if (velocity < -velocityThreshold) {
    // Sheet growing — pick the next snap strictly above current height.
    const above = ascending.find((s) => s.height > currentHeight);
    return (above ?? ascending[ascending.length - 1]).name;
  }

  let nearest = ascending[0];
  let bestDist = Math.abs(nearest.height - currentHeight);
  for (const s of ascending) {
    const d = Math.abs(s.height - currentHeight);
    if (d < bestDist) {
      bestDist = d;
      nearest = s;
    }
  }
  return nearest.name;
}
