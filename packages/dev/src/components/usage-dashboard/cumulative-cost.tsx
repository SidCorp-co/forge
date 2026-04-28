import { fmtCost } from "./helpers";

export function CumulativeCost({ daily, gradientId }: { daily: { cost: number }[]; gradientId: string }) {
  let running = 0;
  const points = daily.map((d) => {
    running += d.cost;
    return running;
  });
  const max = running || 1;
  const w = 180;
  const h = 40;
  const pathD = points
    .map((c, i) => {
      const x = (i / Math.max(points.length - 1, 1)) * w;
      const y = h - (c / max) * (h - 4);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Cumulative Cost</span>
        <span className="mt-0.5 block text-2xl font-bold tabular-nums text-orange-600">{fmtCost(running)}</span>
      </div>
      <svg width={w} height={h} className="ml-auto shrink-0">
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
