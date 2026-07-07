"use client";

// Live runs card (ISS-379, AC#3) — pipeline runs genuinely executing a step
// right now, with their current stage + cost-so-far. Each row links to the
// run's issue (or the pipeline board when the run has no issue, e.g. pm/system
// runs). Runs parked at the manual release gate are NOT live work — see
// `AwaitingReleaseCard` — so callers must pass `activeRuns(...)`, not
// `liveRuns(...)`, or this card silently re-absorbs the noise it was split out
// to remove.
import { useRouter } from "next/navigation";
import { Card, CardContent, Icon, LiveDot, StatusChip } from "@/design";
import { stageColor } from "@/design/stages";
import { formatUsd, jobTypeToStage } from "@/features/pipeline/derive";
import type { PipelineRunKind, PipelineRunListItem } from "@/features/pipeline/types";

// ISS-460 — humanized label for runs with no issue (pm/system/interactive).
const KIND_LABEL: Record<PipelineRunKind, string> = {
  issue: "Issue run",
  pm: "PM run",
  interactive: "Interactive session",
  system: "System run",
};
function runLabel(kind: PipelineRunKind): string {
  return KIND_LABEL[kind] ?? `${kind} run`;
}

export function LiveRunsCard({ runs, slug }: { runs: PipelineRunListItem[]; slug: string }) {
  const router = useRouter();

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="pipeline" size={16} className="text-subtle" />
          <h3 className="fg-h3">Live runs</h3>
        </div>
        <LiveDot state={runs.length > 0 ? "live" : "offline"} />
      </div>
      <CardContent className="flex-1">
        {runs.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No runs are live right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => {
              const stage = jobTypeToStage(run.currentStep);
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <span className="size-2 flex-none rounded-full" style={{ background: stageColor(stage) }} />
                    <StatusChip
                      status={run.status === "paused" ? "paused" : "running"}
                      stage={run.status === "paused" ? undefined : (run.currentStep ?? stage)}
                      domain="session"
                      size="sm"
                    />
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-muted">
                      {run.issueRef ? (
                        <>
                          <span className="font-mono text-fg">{run.issueRef}</span>
                          {run.issueTitle ? ` ${run.issueTitle}` : ""}
                        </>
                      ) : (
                        runLabel(run.kind)
                      )}
                    </span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatUsd(run.cost?.estimatedCost)}
                    </span>
                    <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
