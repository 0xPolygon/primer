import type { DailyStackPoint } from '@polygonlabs/primer-api-types';
import { linearScale, niceTicks, formatTickDate } from './chartGeom.ts';
import { t } from '../../i18n/index.ts';

interface Props {
  data: DailyStackPoint[];
  height?: number;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 32 };
const WIDTH = 600;
const SERIES = [
  { key: 'comments' as const, className: 'fill-blue-300 dark:fill-blue-900' },
  { key: 'versions' as const, className: 'fill-blue-400 dark:fill-blue-800' },
  { key: 'documents' as const, className: 'fill-blue-500 dark:fill-blue-700' },
];

export function AreaChart({ data, height = 200 }: Props) {
  const totals = data.map((p) => p.documents + p.versions + p.comments);
  const yMax = Math.max(1, ...totals);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, yMax], [PAD.top + innerH, PAD.top]);

  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }

  // Cumulative offsets for stacked areas: comments first (closest to baseline).
  const stacks = data.map((p) => {
    const a = p.comments;
    const b = a + p.versions;
    const c = b + p.documents;
    return [0, a, b, c];
  });

  const polygons = SERIES.map((s, seriesIdx) => {
    const top = data.map((_p, i) => `${x(i)},${y(stacks[i][seriesIdx + 1])}`).join(' ');
    const bottom = data.map((_p, i) => `${x(i)},${y(stacks[i][seriesIdx])}`).reverse().join(' ');
    return <polygon key={s.key} className={s.className} points={`${top} ${bottom}`} />;
  });

  const yTicks = niceTicks(0, yMax, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label={t('areaChart.dailyContentCreated')}>
      {polygons}
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {Math.round(t)}
        </text>
      ))}
      {xTickIndices.map((i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {formatTickDate(data[i].date)}
        </text>
      ))}
    </svg>
  );
}

export function EmptyChart({ width, height }: { width: number; height: number }) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={t('areaChart.noData')}>
      <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle"
            className="text-xs fill-neutral-400 dark:fill-neutral-500">
        {t('areaChart.noDataYet')}
      </text>
    </svg>
  );
}
