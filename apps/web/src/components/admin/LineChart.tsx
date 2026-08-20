import type { DailyPoint } from '@polygonlabs/primer-api-types';
import { linearScale, niceTicks, formatTickDate } from './chartGeom.ts';
import { EmptyChart } from './AreaChart.tsx';

interface Props {
  data: DailyPoint[];
  height?: number;
  formatY?: (n: number) => string;
  ariaLabel?: string;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };
const WIDTH = 600;

export function LineChart({ data, height = 200, formatY, ariaLabel }: Props) {
  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yMax = Math.max(1, ...data.map((p) => p.value));
  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, yMax], [PAD.top + innerH, PAD.top]);

  const points = data.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');

  const yTicks = niceTicks(0, yMax, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  const fmt = formatY ?? ((n: number) => String(Math.round(n)));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      <polyline points={points} className="fill-none stroke-blue-500 dark:stroke-blue-400" strokeWidth="2" />
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {fmt(t)}
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
