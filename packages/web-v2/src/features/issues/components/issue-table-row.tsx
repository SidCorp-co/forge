"use client";

// Shared building blocks for the Issues list: the row-action contract
// (`RowActions`), the humanized priority/complexity/assignee option lists, and
// the lazy per-row dependency + cost cells. The active row/card renderers live
// in `issue-row-actions.tsx` (ISS-293 redesign) and consume these exports; the
// rail and new-issue dialog reuse the option lists.

import { Stat, type SelectOption } from "@/design";
import type { PatchIssueInput } from "../api";
import { useIssueCost, useIssueDeps } from "../hooks";
import { COMPLEXITY_LABELS, PRIORITY_LABELS, depCounts } from "../derive";
import type { IssueStatus, ProjectMember } from "../types";

export interface RowActions {
  patch: (args: { id: string; body: PatchIssueInput }) => void;
  transition: (args: { id: string; toStatus: IssueStatus }) => void;
  isPending: boolean;
}

// Option lists keep the raw enum `value` (server contract) but show humanized
// labels (`PRIORITY_LABELS`/`COMPLEXITY_LABELS` from derive). Imported by both
// the table and the properties rail, so both render professional text.
export const PRIORITY_OPTIONS: SelectOption[] = [
  { value: "critical", label: PRIORITY_LABELS.critical },
  { value: "high", label: PRIORITY_LABELS.high },
  { value: "medium", label: PRIORITY_LABELS.medium },
  { value: "low", label: PRIORITY_LABELS.low },
  { value: "none", label: PRIORITY_LABELS.none },
];

export const COMPLEXITY_OPTIONS: SelectOption[] = [
  { value: "", label: "—" },
  { value: "xs", label: COMPLEXITY_LABELS.xs },
  { value: "s", label: COMPLEXITY_LABELS.s },
  { value: "m", label: COMPLEXITY_LABELS.m },
  { value: "l", label: COMPLEXITY_LABELS.l },
  { value: "xl", label: COMPLEXITY_LABELS.xl },
];

export function assigneeOptions(members: ProjectMember[] | undefined): SelectOption[] {
  return [
    { value: "", label: "Unassigned" },
    ...(members ?? []).map((m) => ({ value: m.userId, label: m.email })),
  ];
}

/** Lazy dependency badges (🔒 blocked-by · → blocks). */
export function DepBadges({ id }: { id: string }) {
  const { data } = useIssueDeps(id);
  const { blockedBy, blocks } = depCounts(data);
  if (!blockedBy && !blocks) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {blockedBy > 0 && (
        <span className="fg-caption inline-flex items-center gap-0.5" title={`Blocked by ${blockedBy}`}>
          🔒 {blockedBy}
        </span>
      )}
      {blocks > 0 && (
        <span className="fg-caption inline-flex items-center gap-0.5" title={`Blocks ${blocks}`}>
          → {blocks}
        </span>
      )}
    </span>
  );
}

/** Lazy per-issue cost. */
export function CostCell({ id }: { id: string }) {
  const { data, isLoading } = useIssueCost(id);
  if (isLoading) return <span className="fg-caption">…</span>;
  const cost = data?.estimatedCost ?? 0;
  return <Stat icon="dollar">{cost > 0 ? `$${cost.toFixed(2)}` : "—"}</Stat>;
}
