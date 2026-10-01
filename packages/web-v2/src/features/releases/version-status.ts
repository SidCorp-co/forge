import type { ReleaseVersionFilter, ReleaseVersionRow, ReleaseVersionStatus } from "./versions-types";

type Tone = "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";

export const STATUS_LABEL: Record<ReleaseVersionStatus, { label: string; tone: Tone }> = {
  in_progress: { label: "in progress", tone: "cobalt" },
  awaiting_approval: { label: "awaiting approval", tone: "amber" },
  returned: { label: "returned", tone: "amber" },
  shipped: { label: "production", tone: "green" },
  rolled_back: { label: "rolled back", tone: "red" },
  failed: { label: "failed", tone: "red" },
  aborted: { label: "aborted", tone: "neutral" },
};

export function statusLabel(v: Pick<ReleaseVersionRow, "status" | "current">) {
  if (v.status === "shipped" && !v.current) return { label: "superseded", tone: "neutral" as Tone };
  return STATUS_LABEL[v.status];
}

export function matchesFilter(v: ReleaseVersionRow, f: ReleaseVersionFilter): boolean {
  if (f === "all") return true;
  if (f === "live") return v.status === "shipped";
  return v.status === f;
}

export const FILTER_LABEL: Record<ReleaseVersionFilter, string> = {
  all: "All",
  awaiting_approval: "Awaiting approval",
  live: "Live",
  rolled_back: "Rolled back",
};

export function filterCount(
  counts: { all: number; awaitingApproval: number; live: number; rolledBack: number },
  f: ReleaseVersionFilter,
): number {
  return { all: counts.all, awaiting_approval: counts.awaitingApproval, live: counts.live, rolled_back: counts.rolledBack }[f];
}
