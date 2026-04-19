import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useId } from "react";
import { getUsageSummary, ingestCliUsage } from "@/lib/api";
import { Skeleton, EmptyState, SegmentedControl } from "@/components/ui";
import { UsageMetric } from "./usage-metric";
import { SourceChips } from "./source-chips";
import { DailyChart } from "./daily-chart";
import { CumulativeCost } from "./cumulative-cost";
import { ModelBreakdown } from "./model-breakdown";
import { SourceBreakdown } from "./source-breakdown";
import { fmt, fmtCost, localDate, DAY_OPTIONS } from "./helpers";

export function UsageDashboard() {
  const gradientId = useId();
  const [days, setDays] = useState(7);
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ["usage-summary", days],
    queryFn: () => getUsageSummary(days),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const ingest = useMutation({
    mutationFn: ingestCliUsage,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["usage-summary"] });
    },
    onError: (error) => {
      console.error("[usage] CLI ingest failed:", error);
    },
  });

  const toggleSource = (s: string) => {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const daily = summary?.daily ?? [];
  const maxTokens = daily.reduce((m, d) => Math.max(m, d.input + d.output), 1);
  const maxCost = daily.reduce((m, d) => Math.max(m, d.cost), 0);
  const today = localDate();
  const todayData = daily.find((d) => d.date === today);

  const filteredSources = useMemo(() => {
    if (!summary) return [];
    if (activeSources.size === 0) return summary.bySource;
    return summary.bySource.filter((s) => activeSources.has(s.source));
  }, [summary, activeSources]);

  const models = summary?.byModel ?? [];

  if (isLoading) {
    return (
      <section className="mt-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (isError || !summary) {
    return (
      <section className="mt-8">
        <EmptyState title="Failed to load usage data." />
      </section>
    );
  }

  return (
    <section className="mt-8 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Usage</h2>
          <SourceChips sources={summary.bySource} active={activeSources} onToggle={toggleSource} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => ingest.mutate()}
            disabled={ingest.isPending}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-gray-600 transition-all hover:border-gray-300 hover:text-gray-900 disabled:opacity-50"
          >
            {ingest.isPending ? "Syncing..." : ingest.isError ? "Retry Sync" : "Sync CLI"}
          </button>
          <SegmentedControl options={DAY_OPTIONS} value={String(days)} onChange={(v) => setDays(Number(v))} />
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <UsageMetric
          label="Tokens Today"
          value={fmt((todayData?.input ?? 0) + (todayData?.output ?? 0))}
          sub={`${fmt(todayData?.input ?? 0)} in / ${fmt(todayData?.output ?? 0)} out`}
        />
        <UsageMetric label="Cost Today" value={fmtCost(todayData?.cost ?? 0)} accent />
        <UsageMetric label="Requests" value={fmt(summary.totals.requests)} sub={`${days}d total`} />
        <UsageMetric label="Total Cost" value={fmtCost(summary.totals.estimatedCost)} sub={`${days}d total`} accent />
        <UsageMetric
          label="Top Model"
          value={(models[0]?.model ?? "—").replace("claude-", "").replace(/-\d{8}$/, "").slice(0, 14)}
          sub={models[0] ? fmtCost(models[0].cost) : undefined}
        />
      </div>

      {/* Cumulative */}
      <CumulativeCost daily={daily} gradientId={`cumGrad${gradientId}`} />

      {/* Chart */}
      <DailyChart daily={daily} maxTokens={maxTokens} maxCost={maxCost} />

      {/* Bottom grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ModelBreakdown models={models} />
        <SourceBreakdown sources={filteredSources} />
      </div>
    </section>
  );
}
