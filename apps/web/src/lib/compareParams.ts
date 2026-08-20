import type { VersionSummaryDTO } from '@polygonlabs/primer-api-types';

export type CompareView = 'split' | 'unified';

export function parseViewParam(raw: string | null): CompareView {
  return raw === 'unified' ? 'unified' : 'split';
}

export type CompareResolution =
  | { kind: 'invalid' }
  | { kind: 'not-found'; missing: number }
  | { kind: 'identical'; version: VersionSummaryDTO }
  | { kind: 'ok'; from: VersionSummaryDTO; to: VersionSummaryDTO };

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function resolveCompareParams(
  versions: VersionSummaryDTO[],
  fromV: string | undefined,
  toV: string | undefined,
): CompareResolution {
  const fromN = parsePositiveInt(fromV);
  const toN = parsePositiveInt(toV);
  if (fromN === null || toN === null) return { kind: 'invalid' };

  const from = versions.find((x) => x.versionNumber === fromN);
  if (!from) return { kind: 'not-found', missing: fromN };

  const to = versions.find((x) => x.versionNumber === toN);
  if (!to) return { kind: 'not-found', missing: toN };

  if (fromN === toN) return { kind: 'identical', version: from };

  return { kind: 'ok', from, to };
}

export function pickDefaultFromVersion(
  versions: VersionSummaryDTO[],
  toVersionNumber: number,
): VersionSummaryDTO | null {
  // Versions arrive in descending order; the "version just below" the target
  // is the next one in the list after the target.
  const idx = versions.findIndex((x) => x.versionNumber === toVersionNumber);
  if (idx === -1) return null;
  return versions[idx + 1] ?? null;
}
