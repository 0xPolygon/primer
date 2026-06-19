export function linearScale(
  domain: [number, number],
  range: [number, number],
): (x: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const slope = (r1 - r0) / (d1 - d0);
  return (x) => r0 + (x - d0) * slope;
}

export function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(min + i * step);
  }
  return ticks;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTickDate(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

// Base 1000 (decimal SI) so 1500 bytes = "1.5 KB". Matches the test expectations.
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
