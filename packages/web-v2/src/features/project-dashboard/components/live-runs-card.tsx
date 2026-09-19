"use client";

import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardTitle,
  Icon,
  LiveDot,
  StatusChip,
} from "@/design";
import { stageColor } from "@/design/stages";
import { formatUsd } from "@/features/pipeline/derive";
import type { PipelineRunKind, PipelineRunListItem } from "@/features/pipeline/types";

const KIND_LABEL: Record<PipelineRunKind, string> = {
  issue: "Issue run",
  pm: "PM run",
  interactive: "Interactive session",
  system: "System run",
};
function runLabel(kind: PipelineRunKind): string {
  return KIND_LABEL[kind] ?? `${kind} run`;
}

export function LiveRunsCard({
  runs,
  slug,
  idle = [],
}: {
  runs: PipelineRunListItem[];
  slug: string;
  /** ISS-789 — runs still open with no live JOB on them. Shown as a count
   *  rather than hidden: they were invisible before. */
  idle?: PipelineRunListItem[];
}) {
  const router = useRouter();

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="pipeline" size={16} className="text-subtle" />
          <CardTitle>Live runs</CardTitle>
        </div>
        <LiveDot state={runs.length > 0 ? "live" : "offline"} />
      </div>
      <CardContent className="flex-1">
        {runs.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No runs are live right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => {
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <span className="size-2 flex-none rounded-full" style={{ background: stageColor(run.currentStep ?? "") }} />
                    <StatusChip
                      status={run.status === "paused" ? "paused" : "running"}
                      stage={run.status === "paused" ? undefined : (run.currentStep ?? undefined)}
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
        {idle.length > 0 && (
          <button
            type="button"
            onClick={() => router.push(`/projects/${slug}/pipeline`)}
            className="fg-caption mt-3 flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-muted transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="pause" size={13} className="flex-none text-subtle" />
            <span className="min-w-0 flex-1">
              {idle.length} {idle.length === 1 ? "run has" : "runs have"} no job running
            </span>
            <Icon name="chevronRight" size={13} className="flex-none text-subtle" />
          </button>
        )}
      </CardContent>
    </Card>
  );
}
