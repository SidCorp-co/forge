import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getIssues } from "@/lib/api";
import type { Issue, IssueStatus } from "@/lib/types";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

interface PipelineStage {
  key: string;
  label: string;
  statuses: IssueStatus[];
  emoji: string;
}

const PIPELINE_STAGES: PipelineStage[] = [
  { key: "intake", label: "Intake", statuses: ["open", "needs_info"], emoji: "📥" },
  { key: "triage", label: "Triage", statuses: ["confirmed", "clarified", "waiting"], emoji: "🔍" },
  { key: "approved", label: "Ready", statuses: ["approved"], emoji: "✅" },
  { key: "development", label: "Development", statuses: ["in_progress", "developed"], emoji: "💻" },
  { key: "deploy_test", label: "Deploy & Test", statuses: ["deploying", "testing"], emoji: "🚀" },
  { key: "review", label: "Awaiting release", statuses: ["tested"], emoji: "👁" },
  { key: "done", label: "Done", statuses: ["released", "closed"], emoji: "🏁" },
  { key: "blocked", label: "Blocked", statuses: ["reopen", "on_hold"], emoji: "⚠️" },
];

const BOTTLENECK_HOURS: Record<string, number> = {
  intake: 24, triage: 12, approved: 48, development: 24,
  deploy_test: 12, review: 24, blocked: 4,
};

function getTimeInStage(issue: Issue): number {
  const history = issue.changeHistory ?? [];
  if (history.length > 0 && typeof history[0] === "string") {
    const timestamps = (history as unknown as string[])
      .filter((s) => s.includes("changed status"))
      .map((s) => { const m = s.match(/^\[(.+?)\]/); return m ? new Date(m[1]).getTime() : 0; })
      .filter((t) => t > 0)
      .sort((a, b) => b - a);
    if (timestamps.length > 0) return Date.now() - timestamps[0];
  }
  if (history.length > 0 && typeof history[0] === "object" && history[0] !== null && "field" in history[0]) {
    const statusChanges = (history as { field: string; at: string }[])
      .filter((e) => e.field === "status")
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    if (statusChanges.length > 0) return Date.now() - new Date(statusChanges[0].at).getTime();
  }
  return Date.now() - new Date(issue.createdAt).getTime();
}

function getReopenCount(issue: Issue): number {
  const history = issue.changeHistory ?? [];
  if (history.length > 0 && typeof history[0] === "string") {
    return (history as unknown as string[]).filter((s) => s.includes('"reopen"')).length;
  }
  if (history.length > 0 && typeof history[0] === "object" && history[0] !== null && "field" in history[0]) {
    return (history as { field: string; to: string }[]).filter((e) => e.field === "status" && e.to === "reopen").length;
  }
  return 0;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0m";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function getStageKey(status: IssueStatus): string | null {
  for (const stage of PIPELINE_STAGES) {
    if (stage.statuses.includes(status)) return stage.key;
  }
  return null;
}

function isBottlenecked(issue: Issue): boolean {
  const key = getStageKey(issue.status);
  if (!key || key === "done") return false;
  const threshold = BOTTLENECK_HOURS[key];
  if (threshold == null) return false;
  return getTimeInStage(issue) > threshold * 3600000;
}

export function ProjectPipeline() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data: issues, isLoading } = useQuery({
    queryKey: ["issues", slug],
    queryFn: () => getIssues(slug!),
    enabled: !!slug,
  });

  const allIssues = useMemo(() => (issues ?? []).filter((i) => i.status !== "draft"), [issues]);

  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["issues", slug] });
  }, [queryClient, slug]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refetch, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  const activeIssues = allIssues.filter((i) => i.status !== "released" && i.status !== "closed");
  const bottleneckedCount = activeIssues.filter(isBottlenecked).length;

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-outline-variant/20 flex items-center justify-between">
        <div>
          <SectionLabel>Pipeline Progress</SectionLabel>
          <p className="text-xs text-on-surface-variant mt-1">
            {activeIssues.length} active · {bottleneckedCount} bottlenecked
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant uppercase tracking-widest cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={() => setAutoRefresh(!autoRefresh)}
              className="h-3 w-3 rounded border-outline-variant"
            />
            Live
          </label>
          <button
            onClick={refetch}
            className="px-2 py-1 text-[10px] text-on-surface-variant hover:text-on-surface transition-colors uppercase tracking-widest"
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stage Grid */}
      <div className="flex-1 overflow-auto p-6">
        {allIssues.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No pipeline issues"
            description="Issues will appear here as they move through the pipeline."
          />
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {PIPELINE_STAGES.map((stage) => {
              const stageIssues = allIssues
                .filter((i) => stage.statuses.includes(i.status))
                .sort((a, b) => {
                  const aB = isBottlenecked(a) ? 1 : 0;
                  const bB = isBottlenecked(b) ? 1 : 0;
                  if (bB !== aB) return bB - aB;
                  return getTimeInStage(b) - getTimeInStage(a);
                });

              return (
                <div key={stage.key} className="rounded border border-outline-variant/20 bg-surface-dim/30">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/10">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs">{stage.emoji}</span>
                      <span className="text-xs font-semibold text-on-surface uppercase tracking-wide">{stage.label}</span>
                    </div>
                    <span className="text-[10px] font-mono text-on-surface-variant tabular-nums bg-surface-dim px-1.5 py-0.5 rounded">
                      {stageIssues.length}
                    </span>
                  </div>
                  <div className="p-2 space-y-1.5 max-h-80 overflow-y-auto">
                    {stageIssues.map((issue) => {
                      const timeMs = getTimeInStage(issue);
                      const reopens = getReopenCount(issue);
                      const stuck = isBottlenecked(issue);
                      return (
                        <div
                          key={issue.documentId}
                          className={`rounded border border-outline-variant/10 bg-surface p-2 ${stuck ? "border-l-2 border-l-warning" : ""}`}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="font-mono text-[9px] text-primary-dim">ISS-{issue.id}</span>
                            {issue.agentStatus === "running" && (
                              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                            )}
                            {issue.agentStatus === "failed" && (
                              <span className="w-1.5 h-1.5 rounded-full bg-error" />
                            )}
                          </div>
                          <p className="text-[11px] text-on-surface truncate">{issue.title}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[9px] font-mono tabular-nums px-1 py-0.5 rounded ${stuck ? "bg-warning/20 text-warning" : "bg-surface-dim text-on-surface-variant"}`}>
                              {formatDuration(timeMs)}
                            </span>
                            <StatusBadge status={issue.status} />
                            {reopens > 0 && (
                              <span className="flex items-center gap-0.5 text-[9px] font-mono text-error">
                                ↻{reopens}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {stageIssues.length === 0 && (
                      <p className="py-4 text-center text-[10px] text-on-surface-variant/50">No issues</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
