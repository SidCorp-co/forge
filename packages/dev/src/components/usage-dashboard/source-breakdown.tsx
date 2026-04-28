import { fmt, fmtCost, pct } from "./helpers";

export function SourceBreakdown({
  sources,
}: {
  sources: { source: string; input: number; output: number; cost: number; requests: number }[];
}) {
  const total = sources.reduce((s, x) => s + x.input + x.output, 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">By Source</span>
      <div className="mt-3 space-y-3">
        {sources.map((s) => {
          const tokens = s.input + s.output;
          return (
            <div key={s.source} className="flex items-center gap-3">
              <span className="w-14 text-xs font-medium capitalize text-gray-700">{s.source}</span>
              <div className="flex h-6 flex-1 overflow-hidden rounded bg-gray-100">
                <div className="h-full bg-blue-400" style={{ width: `${pct(s.input, total)}%` }} title={`Input: ${fmt(s.input)}`} />
                <div className="h-full bg-blue-600" style={{ width: `${pct(s.output, total)}%` }} title={`Output: ${fmt(s.output)}`} />
              </div>
              <div className="flex flex-col items-end text-[11px] tabular-nums">
                <span className="font-medium text-gray-700">{fmt(tokens)}</span>
                <span className="text-gray-400">{fmtCost(s.cost)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
