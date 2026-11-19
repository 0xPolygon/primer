import type { DailyPoint } from '@polygonlabs/primer-api-types';
import { linearScale } from './chartGeom.ts';
import { t } from '../../i18n/index.ts';

interface Props {
  data: DailyPoint[];
  width?: number;
  height?: number;
}

export function Sparkline({ data, width = 120, height = 32 }: Props) {
  if (data.length === 0) {
    return <svg viewBox={`0 0 ${width} ${height}`} className="w-full" />;
  }
  const max = Math.max(1, ...data.map((p) => p.value));
  const x = linearScale([0, Math.max(1, data.length - 1)], [0, width]);
  const y = linearScale([0, max], [height - 2, 2]);
  const points = data.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={t('sparkline.agingThreadsTrend')}>
      <polyline points={points} className="fill-none stroke-amber-500 dark:stroke-amber-400" strokeWidth="1.5" />
    </svg>
  );
}
