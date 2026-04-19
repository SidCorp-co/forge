import { fmt, fmtCost, pct, modelColor } from "./helpers";

export function ModelBreakdown({
  models,
}: {
  models: { model: string; input: number; output: number; cost: number; requests: number }[];
}) {
  const maxCost = models.reduce((m, x) => Math.max(m, x.cost), 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">By Model</span>
      <div className="mt-3 space-y-2.5">
        {models.map((m) => {
          const color = modelColor(m.model);
          const w = maxCost > 0 ? Math.max(2, pct(m.cost, maxCost)) : 0;
          return (
            <div key={m.model}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="max-w-[180px] truncate font-medium text-gray-700" title={m.model}>
                  {m.model === "unknown" ? "unknown" : m.model.replace("claude-", "").replace(/-\d{8}$/, "")}
                </span>
                <div className="flex items-center gap-3 tabular-nums text-gray-400">
                  <span>{fmt(m.input + m.output)} tok</span>
                  <span>{m.requests} req</span>
                  <span className="font-semibold text-gray-700">{fmtCost(m.cost)}</span>
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full" style={{ width: `${w}%`, backgroundColor: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
