import type { ThreadFlowPoint } from '@polygonlabs/primer-api-types';
import { linearScale, formatTickDate, niceTicks } from './chartGeom.ts';
import { EmptyChart } from './AreaChart.tsx';

interface Props {
  data: ThreadFlowPoint[];
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 8, right: 8, bottom: 22, left: 32 };

export function StackedBar({ data, height = 200 }: Props) {
  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(1, ...data.map((p) => p.opened + p.resolved));
  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, max], [PAD.top + innerH, PAD.top]);
  const barW = innerW / data.length * 0.6;

  const yTicks = niceTicks(0, max, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Threads opened and resolved per day">
      {data.map((p, i) => {
        const cx = x(i);
        const openedH = (innerH * p.opened) / max;
        const resolvedH = (innerH * p.resolved) / max;
        const openedY = y(p.opened);
        const resolvedY = openedY - resolvedH;
        return (
          <g key={p.date}>
            <rect
              x={cx - barW / 2}
              y={openedY}
              width={barW}
              height={openedH}
              className="fill-amber-400 dark:fill-amber-700"
            />
            <rect
              x={cx - barW / 2}
              y={resolvedY}
              width={barW}
              height={resolvedH}
              className="fill-emerald-500 dark:fill-emerald-700"
            />
          </g>
        );
      })}
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
