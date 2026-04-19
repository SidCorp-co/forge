import { useQuery } from "@tanstack/react-query";
import { getIssueCostSummary } from "@/lib/api";


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function prettifyStep(skill: string): string {
  return skill
    .replace(/^forge-/, "")
    .replace(/-/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function IssueCostSummary({ documentId }: { documentId: string }) {
  const { data } = useQuery({
    queryKey: ["issue-cost", documentId],
    queryFn: () => getIssueCostSummary(documentId),
    enabled: !!documentId,
    staleTime: 30_000,
  });

  if (!data || data.sessionCount === 0) return null;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
          Cost Summary
        </h4>
        <span className="font-mono text-sm font-bold text-gray-200">
          ${data.totalCost.toFixed(2)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="font-mono text-xs font-medium text-gray-200">
            {formatTokens(data.totalOutputTokens)}
          </div>
          <div className="text-[9px] text-gray-500 uppercase tracking-widest">Output</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-gray-200">
            {formatTokens(data.totalCacheReadTokens)}
          </div>
          <div className="text-[9px] text-gray-500 uppercase tracking-widest">Cache</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-gray-200">{data.totalTurns}</div>
          <div className="text-[9px] text-gray-500 uppercase tracking-widest">Turns</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-gray-200">{data.sessionCount}</div>
          <div className="text-[9px] text-gray-500 uppercase tracking-widest">Sessions</div>
        </div>
      </div>

      {data.byStep.length > 0 && (
        <div className="space-y-1">
          {data.byStep.map((s) => (
            <div
              key={s.step}
              className="flex items-center justify-between rounded bg-gray-800/50 px-3 py-1.5"
            >
              <span className="text-[10px] font-medium uppercase tracking-widest text-gray-400">
                {prettifyStep(s.step)}
              </span>
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span className="text-gray-500">
                  {formatTokens(s.inputTokens + s.outputTokens)}
                </span>
                <span className="font-medium text-gray-300">${s.cost.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
