"use client";

// Skill-update review surface (Update Pipeline stage ②, ISS-795).
//
// The pipeline routes any non-additive skill change to a human gate, and until
// this screen existed that human had no door: a `decided` run sat forever
// unless someone called MCP or POSTed by hand. Runs waiting on a person are
// pinned to the top for exactly that reason.
import { useMemo, useState } from "react";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { awaitsHuman, useReconcileRuns } from "../hooks";
import type { ReconcileRunSummary } from "../types";
import { RunReview } from "./run-review";

export interface SkillUpdatesScreenProps {
  scope: { projectId: string; canManage: boolean };
}

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: ReconcileRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const waiting = awaitsHuman(run);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={`border-line w-full border-b px-3 py-3 text-left last:border-b-0 hover:bg-hover ${
        selected ? "bg-hover" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {waiting ? <Badge tone="amber">Needs you</Badge> : null}
        <Badge tone={run.verdict === "escalate" ? "red" : "neutral"}>
          {run.verdict ?? run.status}
        </Badge>
        <span className="text-muted text-xs">{relative(run.createdAt)}</span>
      </div>
      <p className="text-muted mt-1 truncate text-xs">run {run.id.slice(0, 8)}</p>
    </button>
  );
}

export function SkillUpdatesScreen({ scope }: SkillUpdatesScreenProps) {
  const { data: runs, isLoading, isError, error, refetch } = useReconcileRuns(scope.projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Runs that need a decision come first; everything else is history.
  const ordered = useMemo(() => {
    const rows = runs ?? [];
    return [...rows].sort((a, b) => {
      const aw = awaitsHuman(a) ? 0 : 1;
      const bw = awaitsHuman(b) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [runs]);

  const waitingCount = ordered.filter(awaitsHuman).length;
  const selected = selectedId ?? ordered[0]?.id ?? null;

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No skill updates yet"
          message="When an update packet reaches this project, the agent's proposal shows up here for review."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4">
      {waitingCount > 0 ? (
        <p className="text-sm">
          <strong>{waitingCount}</strong> update{waitingCount === 1 ? "" : "s"} waiting on a
          decision.
        </p>
      ) : null}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <Card className="min-h-0 overflow-auto">
          {ordered.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              selected={run.id === selected}
              onSelect={() => setSelectedId(run.id)}
            />
          ))}
        </Card>

        <Card className="min-h-0 overflow-auto">
          {selected ? (
            <RunReview projectId={scope.projectId} runId={selected} canManage={scope.canManage} />
          ) : (
            <div className="p-4">
              <EmptyState message="Pick an update to review it." mascot={false} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
