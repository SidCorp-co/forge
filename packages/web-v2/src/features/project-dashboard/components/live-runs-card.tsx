"use client";

import { useRouter } from "next/navigation";
import { Icon, LiveDot, StatusChip } from "@/design";
import { formatUsd } from "@/lib/utils/format";
import type { PipelineRunKind, PipelineRunListItem } from "@/features/runs/types";
import type { ReadState } from "../shape";
import { DashboardSection, EmptyLine, RowList, unreadSection } from "./dashboard-section";

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
  read,
}: {
  runs: PipelineRunListItem[];
  slug: string;
  /** ISS-789 — runs still open with no live JOB on them. Shown as a count rather than hidden. */
  idle?: PipelineRunListItem[];
  /** The runs read. Until it is in, the section says so and states no run, none live, and no idle count. */
  read?: ReadState;
}) {
  const router = useRouter();

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  const idleNote = idle.length > 0 && (
    <button
      type="button"
      onClick={() => router.push(`/projects/${slug}/pipeline`)}
      className="fg-caption mt-1 flex w-full items-center gap-1.5 rounded-md py-2 text-left text-muted transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <Icon name="pause" size={13} className="flex-none text-subtle" />
      <span className="min-w-0 flex-1">
        {idle.length} {idle.length === 1 ? "run has" : "runs have"} no job running
      </span>
      <Icon name="chevronRight" size={13} className="flex-none text-subtle" />
    </button>
  );

  const unread = unreadSection("Live runs", "The project's runs", read, true);
  if (unread) return unread;

  if (runs.length === 0) {
    return (
      <div>
        <EmptyLine title="Live runs" status="none live right now" />
        {idleNote}
      </div>
    );
  }

  return (
    <DashboardSection title="Live runs" aside={<LiveDot state="live" />}>
      <RowList>
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => open(run)}
              className="flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <span className="size-2 flex-none rounded-full" style={{ background: "var(--pipeline-active)" }} />
              <StatusChip
                status={run.status === "paused" ? "paused" : "running"}
                stage={run.status === "paused" ? undefined : (run.currentStep ?? undefined)}
                label={run.status === "paused" ? "Paused" : undefined}
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
        ))}
      </RowList>
      {idleNote}
    </DashboardSection>
  );
}
