"use client";

// Calmer issue row renderers for the Issues list (ISS-293 redesign).
//
// The always-visible inline `<Select>`s that used to live in every table cell
// (priority / complexity / assignee) and the StatusChip-menu now read as
// quiet, read-only display cells. Every mutation (status transition + the three
// PATCH fields) is folded into ONE hover/overflow row-action `Menu` so the
// table reads calmly. No behaviour is lost: the menu exposes the full status
// enum + every priority / complexity / assignee option, committing through the
// same `actions.patch` / `actions.transition` mutations the screen passes down.

import { useRouter } from "next/navigation";
import {
  Avatar,
  Badge,
  Card,
  CardContent,
  IconButton,
  Menu,
  MonoTag,
  PipelineTracker,
  StatusChip,
  TD,
  TR,
  type MenuItem,
} from "@/design";
import {
  allowedTransitions,
  complexityLabel,
  initials,
  memberLabel,
  priorityLabel,
  statusLabel,
  statusToChip,
  statusToRun,
  statusToStage,
} from "../derive";
import {
  ISSUE_COMPLEXITIES,
  ISSUE_PRIORITIES,
  type IssuePriority,
  type IssueRow,
  type ProjectMember,
} from "../types";
import { CostCell, DepBadges, HoldBadge, type RowActions } from "./issue-table-row";

// Priority badge tone — quiet for low/none, warm for the urgent end.
const PRIORITY_TONE: Record<IssuePriority, "red" | "amber" | "neutral"> = {
  critical: "red",
  high: "amber",
  medium: "neutral",
  low: "neutral",
  none: "neutral",
};

/** Read-only priority pill. `none` collapses to a muted dash. */
function PriorityCell({ priority }: { priority: IssuePriority }) {
  if (priority === "none") return <span className="fg-caption text-subtle">—</span>;
  return <Badge tone={PRIORITY_TONE[priority]}>{priorityLabel(priority)}</Badge>;
}

/** Read-only complexity pill (was the cryptic "Cx" column). */
function ComplexityCell({ complexity }: { complexity: IssueRow["complexity"] }) {
  if (!complexity) return <span className="fg-caption text-subtle">—</span>;
  return <MonoTag>{complexityLabel(complexity)}</MonoTag>;
}

/**
 * Build the flat list of menu items for a row's overflow ⋯ action. The current
 * value of each field is skipped so every item is an actual change. Labels are
 * prefixed (`Status:` / `Priority:` / …) so the flat list still reads clearly.
 */
function useRowMenuItems(
  row: IssueRow,
  members: ProjectMember[] | undefined,
  actions: RowActions,
  open: () => void,
): MenuItem[] {
  const items: MenuItem[] = [{ label: "Open issue", icon: "arrowRight", onSelect: open }];

  // Only valid next states (mirrors core's runtime guard) so a pick can't 409
  // and silently snap back (ISS-308 E1).
  for (const s of allowedTransitions(row.status)) {
    items.push({ label: `Status: ${statusLabel(s)}`, onSelect: () => actions.transition({ id: row.id, toStatus: s }) });
  }
  for (const p of ISSUE_PRIORITIES) {
    if (p === row.priority) continue;
    items.push({ label: `Priority: ${priorityLabel(p)}`, onSelect: () => actions.patch({ id: row.id, body: { priority: p } }) });
  }
  for (const c of ISSUE_COMPLEXITIES) {
    if (c === row.complexity) continue;
    items.push({ label: `Complexity: ${complexityLabel(c)}`, onSelect: () => actions.patch({ id: row.id, body: { complexity: c } }) });
  }
  if (row.complexity) {
    items.push({ label: "Complexity: clear", onSelect: () => actions.patch({ id: row.id, body: { complexity: null } }) });
  }
  for (const m of members ?? []) {
    if (m.userId === row.assigneeId) continue;
    items.push({ label: `Assign: ${m.email}`, onSelect: () => actions.patch({ id: row.id, body: { assigneeId: m.userId } }) });
  }
  if (row.assigneeId) {
    items.push({ label: "Unassign", onSelect: () => actions.patch({ id: row.id, body: { assigneeId: null } }) });
  }
  return items;
}

/** Overflow row-action menu (⋯). Disabled while a mutation is in flight. */
function RowMenu({
  row,
  members,
  actions,
  open,
  side = "bottom",
}: {
  row: IssueRow;
  members: ProjectMember[] | undefined;
  actions: RowActions;
  open: () => void;
  side?: "top" | "bottom";
}) {
  const items = useRowMenuItems(row, members, actions, open);
  return (
    <Menu
      align="right"
      side={side}
      items={items}
      trigger={
        <IconButton
          icon="more"
          size="sm"
          variant="ghost"
          aria-label="Row actions"
          disabled={actions.isPending}
        />
      }
    />
  );
}

export function IssueTableRow({
  row,
  slug,
  members,
  actions,
}: {
  row: IssueRow;
  slug: string;
  members: ProjectMember[] | undefined;
  actions: RowActions;
}) {
  const router = useRouter();
  const stage = statusToStage(row.status);
  const open = () => router.push(`/projects/${slug}/issues/${row.id}`);

  return (
    <TR className="group">
      <TD>
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${row.displayId}`}
          className="rounded-sm focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          <MonoTag hue="cobalt">{row.displayId}</MonoTag>
        </button>
      </TD>
      <TD className="max-w-[320px]">
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${row.displayId}: ${row.title}`}
          className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          <span className="fg-body-sm block truncate text-fg group-hover:text-accent-text">{row.title}</span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {row.category && <MonoTag>{row.category}</MonoTag>}
          <HoldBadge held={row.manualHold} />
          <DepBadges id={row.id} />
        </div>
      </TD>
      <TD>
        <PipelineTracker stage={stage} status={statusToRun(row.status, row.agentStatus)} variant="mini" />
      </TD>
      <TD>
        <StatusChip status={statusToChip(row.status, row.agentStatus)} />
      </TD>
      <TD>
        <PriorityCell priority={row.priority} />
      </TD>
      <TD>
        <ComplexityCell complexity={row.complexity} />
      </TD>
      <TD className="text-right">
        <CostCell id={row.id} />
      </TD>
      <TD>
        <div className="flex items-center gap-2">
          <Avatar initials={initials(memberLabel(row.assigneeId, members))} size={22} />
          <span className="fg-caption truncate text-muted">{memberLabel(row.assigneeId, members)}</span>
        </div>
      </TD>
      <TD className="text-right">
        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <RowMenu row={row} members={members} actions={actions} open={open} />
        </div>
      </TD>
    </TR>
  );
}

export function IssueMobileCard({
  row,
  slug,
  members,
  actions,
}: {
  row: IssueRow;
  slug: string;
  members: ProjectMember[] | undefined;
  actions: RowActions;
}) {
  const router = useRouter();
  const stage = statusToStage(row.status);
  const open = () => router.push(`/projects/${slug}/issues/${row.id}`);

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${row.displayId}: ${row.title}`}
            className="min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <MonoTag hue="cobalt">{row.displayId}</MonoTag>
            <span className="fg-body-sm mt-1.5 block truncate text-fg">{row.title}</span>
          </button>
          <RowMenu row={row} members={members} actions={actions} open={open} side="bottom" />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {row.category && <MonoTag>{row.category}</MonoTag>}
          <HoldBadge held={row.manualHold} />
          <DepBadges id={row.id} />
        </div>

        <div className="mt-3">
          <PipelineTracker stage={stage} status={statusToRun(row.status, row.agentStatus)} variant="mini" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusChip status={statusToChip(row.status, row.agentStatus)} size="sm" />
          <PriorityCell priority={row.priority} />
          <ComplexityCell complexity={row.complexity} />
          <span className="ml-auto">
            <CostCell id={row.id} />
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Avatar initials={initials(memberLabel(row.assigneeId, members))} size={22} />
          <span className="fg-caption truncate text-muted">{memberLabel(row.assigneeId, members)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
