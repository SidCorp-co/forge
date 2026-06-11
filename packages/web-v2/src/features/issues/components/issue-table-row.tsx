"use client";

// Shared building blocks for the Issues list: the row-action contract
// (`RowActions`), the humanized priority/complexity/assignee option lists, and
// the lazy per-row dependency + cost cells. The active row/card renderers live
// in `issue-row-actions.tsx` (ISS-293 redesign) and consume these exports; the
// rail and new-issue dialog reuse the option lists.

import {
  Icon,
  type IconName,
  Menu,
  type MenuItem,
  type SelectOption,
  Stat,
} from "@/design";
import { useRouter } from "next/navigation";
import type { PatchIssueInput } from "../api";
import { COMPLEXITY_LABELS, PRIORITY_LABELS } from "../derive";
import { useIssueDeps } from "../hooks";
import type { IssueDependencyEdge, IssueStatus, ProjectMember } from "../types";

export interface RowActions {
  patch: (args: { id: string; body: PatchIssueInput }) => void;
  transition: (args: { id: string; toStatus: IssueStatus }) => void;
  isPending: boolean;
  /** False for project viewers (read-only): the row menu drops every mutation
   *  item and keeps only navigation. Optional — omitted means writable. */
  canWrite?: boolean;
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

export function assigneeOptions(
  members: ProjectMember[] | undefined,
): SelectOption[] {
  return [
    { value: "", label: "Unassigned" },
    ...(members ?? []).map((m) => ({ value: m.userId, label: m.email })),
  ];
}

const isParentEdge = (k: IssueDependencyEdge["kind"]) =>
  k === "decomposes" || k === "parent";

/** Build a Menu item for the OTHER endpoint of a relation edge. `dir` says which
 *  endpoint is "the other one": for an INCOMING edge it's the `from`, for an
 *  OUTGOING edge the `to`. Falls back to a short id + bare "Issue" label when the
 *  edge wasn't enriched (mirrors the rail's `DepList`). */
function edgeToMenuItem(
  e: IssueDependencyEdge,
  dir: "in" | "out",
  slug: string,
  navigate: (id: string) => void,
): MenuItem {
  const isIncoming = dir === "in";
  const otherId = isIncoming ? e.fromIssueId : e.toIssueId;
  const displayId =
    (isIncoming ? e.fromDisplayId : e.toDisplayId) ??
    `ISS-${otherId.slice(0, 6)}`;
  const title = isIncoming ? e.fromTitle : e.toTitle;
  return {
    label: title ? `${displayId} · ${title}` : displayId,
    icon: "arrowRight",
    onSelect: () => navigate(otherId),
  };
}

/** A single readable relation chip that reveals its related issues on click.
 *  The trigger reads as a labelled pill (icon + "Blocked by 2") instead of a
 *  cryptic emoji+count; the dropdown lists the actual `ISS-X · title` issues,
 *  each navigating to that issue (ISS-366 D3). Renders nothing when empty. */
function RelationChip({
  icon,
  label,
  items,
}: { icon: IconName; label: string; items: MenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <Menu
      align="left"
      items={items}
      trigger={
        <button
          type="button"
          className="fg-caption inline-flex items-center gap-1 rounded-pill border border-line px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          title={label}
        >
          <Icon name={icon} size={12} />
          {label}
        </button>
      }
    />
  );
}

/** Lazy dependency badges. Readable labelled chips (Blocked by / Blocks /
 *  Subtasks / Subtask of) that each reveal the actual related `ISS-X` issues —
 *  clickable to navigate — instead of an opaque emoji + count (ISS-366 D3). The
 *  edge data is already enriched (displayId/title/status, ISS-331); no extra
 *  fetch. Renders nothing when the issue has no relations. */
export function DepBadges({ id, slug }: { id: string; slug: string }) {
  const router = useRouter();
  const { data } = useIssueDeps(id);
  const navigate = (otherId: string) =>
    router.push(`/projects/${slug}/issues/${otherId}`);

  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  // Edge `kind` encodes "from <verb> to": an INCOMING `blocks` means this issue
  // is blocked-by; an OUTGOING one means it blocks. `decomposes`/`parent` run
  // parent→child, so an OUTGOING one is a subtask of this epic and an INCOMING
  // one is this issue's parent. Mirrors `depCounts` + the rail's `PropertiesRail`.
  const blockedBy = incoming.filter((e) => e.kind === "blocks");
  const blocks = outgoing.filter((e) => e.kind === "blocks");
  const subtasks = outgoing.filter((e) => isParentEdge(e.kind));
  const parents = incoming.filter((e) => isParentEdge(e.kind));

  if (
    !blockedBy.length &&
    !blocks.length &&
    !subtasks.length &&
    !parents.length
  )
    return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <RelationChip
        icon="lock"
        label={`Blocked by ${blockedBy.length}`}
        items={blockedBy.map((e) => edgeToMenuItem(e, "in", slug, navigate))}
      />
      <RelationChip
        icon="arrowRight"
        label={`Blocks ${blocks.length}`}
        items={blocks.map((e) => edgeToMenuItem(e, "out", slug, navigate))}
      />
      <RelationChip
        icon="grid"
        label={`${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}`}
        items={subtasks.map((e) => edgeToMenuItem(e, "out", slug, navigate))}
      />
      <RelationChip
        icon="fork"
        label={
          parents.length > 1 ? `Subtask of ${parents.length}` : "Subtask of"
        }
        items={parents.map((e) => edgeToMenuItem(e, "in", slug, navigate))}
      />
    </span>
  );
}

/** Per-issue cost from the search row itself (`withCost=1`, ISS-437) — the
 *  old per-row `useIssueCost` lazy fetch was a 25-request N+1 whose silent
 *  failures rendered as "—" exactly like a real zero. `<$0.01` marks a
 *  non-zero cost that would otherwise round down to a misleading dash. */
export function CostCell({ value }: { value: number | undefined }) {
  const cost = value ?? 0;
  const text = cost <= 0 ? "—" : cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
  return <Stat icon="dollar">{text}</Stat>;
}
