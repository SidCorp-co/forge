'use client';

import { fmtCost } from './helpers';

export function CumulativeCost({ daily, gradientId }: { daily: { cost: number }[]; gradientId: string }) {
  let running = 0;
  const points = daily.map((d) => {
    running += d.cost;
    return running;
  });
  const max = running || 1;
  const w = 180;
  const h = 40;
  const pathD =
    points.length > 0
      ? points
          .map((c, i) => {
            const x = (i / Math.max(points.length - 1, 1)) * w;
            const y = h - (c / max) * (h - 4);
            return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
          })
          .join(' ')
      : `M 0 ${h}`;
  const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <span className="text-[11px] font-medium uppercase tracking-wider text-outline">Cumulative Cost</span>
        <span className="mt-0.5 block text-2xl font-bold tabular-nums text-warning">{fmtCost(running)}</span>
      </div>
      <svg width={w} height={h} className="w-full shrink-0 sm:ml-auto sm:w-[180px]">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity={0.15} />
            <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${gradientId})`} />
        <path d={pathD} fill="none" stroke="#f97316" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
