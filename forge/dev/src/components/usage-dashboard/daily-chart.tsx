import { useState } from "react";
import { fmt, fmtCost } from "./helpers";

export function DailyChart({
  daily,
  maxTokens,
  maxCost,
}: {
  daily: { date: string; input: number; output: number; cost: number; requests: number }[];
  maxTokens: number;
  maxCost: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const chartH = 140;
  const barW = Math.max(10, Math.min(28, 560 / daily.length));

  const costPoints = daily
    .map((d, i) => {
      const x = i * (barW + 3) + barW / 2;
      const y = maxCost > 0 ? chartH - (d.cost / maxCost) * chartH : chartH;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Daily Usage</span>
        <div className="flex items-center gap-4 text-[11px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-400" /> Input
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-600" /> Output
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1 w-3 rounded-full bg-orange-400" /> Cost
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg width={daily.length * (barW + 3)} height={chartH + 20} className="min-w-full">
          {[0.25, 0.5, 0.75].map((r) => (
            <line key={r} x1={0} x2="100%" y1={chartH * (1 - r)} y2={chartH * (1 - r)} stroke="#f3f4f6" strokeWidth={1} />
          ))}
          {daily.map((d, i) => {
            const total = d.input + d.output;
            const h = maxTokens > 0 ? (total / maxTokens) * chartH : 0;
            const inputH = total > 0 ? (d.input / total) * h : 0;
            const outputH = h - inputH;
            const x = i * (barW + 3);
            const isH = hovered === i;
            return (
              <g key={d.date} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} className="cursor-crosshair">
                <rect x={x} y={0} width={barW} height={chartH} fill="transparent" />
                {isH && <rect x={x - 1} y={0} width={barW + 2} height={chartH} fill="#f8fafc" rx={2} />}
                <rect x={x + 1} y={chartH - h} width={barW - 2} height={inputH} fill="#60a5fa" rx={1} opacity={isH ? 1 : 0.85} />
                <rect x={x + 1} y={chartH - outputH} width={barW - 2} height={outputH} fill="#2563eb" opacity={isH ? 1 : 0.85} />
                <text x={x + barW / 2} y={chartH + 12} textAnchor="middle" className="fill-gray-400 text-[8px]">
                  {d.date.slice(5)}
                </text>
              </g>
            );
          })}
          {maxCost > 0 && (
            <polyline points={costPoints} fill="none" stroke="#f97316" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
          )}
          {maxCost > 0 &&
            daily.map((d, i) =>
              d.cost > 0 ? (
                <circle key={i} cx={i * (barW + 3) + barW / 2} cy={chartH - (d.cost / maxCost) * chartH} r={hovered === i ? 3.5 : 2} fill="#f97316" opacity={0.9} />
              ) : null,
            )}
        </svg>
      </div>
      {hovered !== null && daily[hovered] && (
        <div className="mt-2 flex gap-4 rounded-md bg-gray-50 px-3 py-1.5 text-[11px] tabular-nums text-gray-600">
          <span className="font-medium text-gray-900">{daily[hovered].date}</span>
          <span>In: {fmt(daily[hovered].input)}</span>
          <span>Out: {fmt(daily[hovered].output)}</span>
          <span>Req: {daily[hovered].requests}</span>
          <span className="font-medium text-orange-600">{fmtCost(daily[hovered].cost)}</span>
        </div>
      )}
    </div>
  );
}
