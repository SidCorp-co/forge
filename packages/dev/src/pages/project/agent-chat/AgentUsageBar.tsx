import { useAppStore } from "@/stores/app-store";
import { CONTEXT_LIMIT, formatTokens } from "@/lib/constants";

export function AgentUsageBar() {
  const usage = useAppStore((s) => s.agentUsage);
  if (usage.turns === 0) return null;

  const pct = Math.min(100, Math.round((usage.contextUsed / CONTEXT_LIMIT) * 100));
  const remaining = Math.max(0, 100 - pct);
  // Red at 60% (600K — session won't be resumable), yellow at 39% (390K — context save kicks in)
  const barColor = pct >= 60 ? "bg-red-500" : pct >= 39 ? "bg-yellow-500" : "bg-green-500";

  return (
    <div className="flex items-center gap-3 bg-[#111111] border-t border-[#333333] px-4 py-1.5 font-mono text-[10px] text-[#666666]">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="shrink-0">ctx: {formatTokens(usage.contextUsed)}/{formatTokens(CONTEXT_LIMIT)}</span>
        <div className="flex-1 h-1.5 rounded-full bg-[#333333] max-w-[120px]">
          <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`shrink-0 ${pct >= 60 ? "text-red-400" : ""}`}>{remaining}% left</span>
      </div>
      <span>out: {formatTokens(usage.outputTotal)}</span>
      {usage.cacheRead > 0 && <span>cache: {formatTokens(usage.cacheRead)}</span>}
      <span className="text-[#555555]">turns: {usage.turns}</span>
    </div>
  );
}
