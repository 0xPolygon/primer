import type { HistogramBucket } from '@polygonlabs/primer-api-types';

interface Props {
  buckets: HistogramBucket[];
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 8, right: 8, bottom: 28, left: 8 };

export function Histogram({ buckets, height = 200 }: Props) {
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const barW = innerW / Math.max(1, buckets.length);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Viewers per document distribution">
      {buckets.map((b, i) => {
        const x = PAD.left + i * barW;
        const h = max === 0 ? 0 : (b.count / max) * innerH;
        const y = PAD.top + innerH - h;
        return (
          <g key={b.bucket}>
            <rect
              x={x + 6}
              y={y}
              width={barW - 12}
              height={Math.max(0, h)}
              className="fill-blue-500 dark:fill-blue-400"
            />
            <text
              x={x + barW / 2}
              y={height - 14}
              textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400"
            >
              {b.bucket}
            </text>
            <text
              x={x + barW / 2}
              y={height - 2}
              textAnchor="middle"
              className="text-[10px] fill-neutral-700 dark:fill-neutral-200"
            >
              {b.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
