"use client";

// Calmer issue row renderers for the Issues list (ISS-293 redesign).

import {
  Avatar,
  Badge,
  Checkbox,
  EnumBadge,
  enumLabel,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  MonoTag,
  Spinner,
  StatusBadge,
  StatusChip,
  TD,
  Tooltip,
  TR,
} from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  complexityLabel,
  initials,
  priorityLabel,
  workStepOf,
} from "../derive";
import { useStatusTone } from "../release-approval";
import {
  deriveQueuedStep,
  hasLiveAgentSession,
  queuedChipStatus,
  type QueuedStepView,
} from "../waiting";
import { groupedTransitions, transitionLabels } from "../derive";
import { AGENT_HOLDS_EDIT, heldByAgent } from "../edit-lock";
import { sinceLastWrite } from "../waiting";
import {
  ISSUE_COMPLEXITIES,
  ISSUE_PRIORITIES,
  type IssueFailureInfo,
  type IssuePriority,
  type IssueRow,
} from "../types";
import {
  DepBadges,
  type RowActions,
  type RowSelection,
  LastWriteCell,
} from "./issue-table-row";
import { WaitingOnPersonChip } from "./waiting-on-person-chip";

/** ISS-700 — shared row-open behaviour: a pending flag set synchronously
 *  before navigation (so the row can dim + show a spinner) and a double-click
 *  guard (a second click during the pending window no-ops). The list stays
 *  mounted through client nav, so `pending` naturally clears on unmount —
 *  no reset needed. */
function useOpenIssue(slug: string, id: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const open = useCallback(() => {
    if (pending) return;
    setPending(true);
    router.push(`/projects/${slug}/issues/${id}`);
  }, [pending, router, slug, id]);
  return { open, pending };
}

/** ISS-700 — step · reason · time label for the Failed-badge tooltip. Falls
 *  back to a calm line when no failure data reached the row (AC #2). */
function failureTooltipLabel(info?: IssueFailureInfo | null): string {
  if (!info) return "No failure details available";
  const step = info.failedStep.charAt(0).toUpperCase() + info.failedStep.slice(1);
  const when = formatRelativeTime(info.failedAt);
  const reason = info.failureReason?.trim();
  const short = reason && reason.length > 140 ? `${reason.slice(0, 139)}…` : reason;
  return short ? `${step} failed · ${short} · ${when}` : `${step} failed · ${when}`;
}

const hasLiveAgent = (s: IssueRow["agentStatus"]): boolean =>
  s === "running" || s === "queued" || s === "failed";

/** Compact execution-state chip — rendered only while an agent is live. The
 *  `failed` chip is wrapped in a `Tooltip` (AC #1) showing the failed step,
 *  reason, and timestamp — non-Failed statuses never get one (AC #6). */
function AgentChip({
  agentStatus,
  failureInfo,
}: {
  agentStatus: IssueRow["agentStatus"];
  failureInfo?: IssueFailureInfo | null;
}) {
  if (!hasLiveAgent(agentStatus)) return null;
  const status =
    agentStatus === "running"
      ? "running"
      : agentStatus === "queued"
        ? "queued"
        : "failed";
  const chip = <StatusChip status={status} domain="session" size="sm" />;
  if (status !== "failed") return chip;
  return (
    <Tooltip label={failureTooltipLabel(failureInfo)} multiline>
      {chip}
    </Tooltip>
  );
}

/** ISS-436 merged status cell: the issue's lifecycle chip, the live agent's chip, and the gate
 *  holding a queued step — three chips, each carrying a fact something recorded. */
export function StatusCell({ row }: { row: IssueRow }) {
  const queuedStep = deriveQueuedStep(
    row.pipelineHealth,
    hasLiveAgentSession(row.agentStatus),
  );
  const tone = useStatusTone(row.status);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge family="issue" value={row.status} step={workStepOf(row)} tone={tone} size="sm" />
      <AgentChip agentStatus={row.agentStatus} failureInfo={row.failureInfo} />
      {queuedStep && <QueuedChip step={queuedStep} />}
    </div>
  );
}

/** ISS-903 — a queued step with no session, labelled with the gate holding it
 *  (or with "Queued" when nothing is). Colour resolves through an existing
 *  StatusKey's tone, like every other chip. */
function QueuedChip({ step }: { step: QueuedStepView }) {
  const chip = (
    <StatusChip
      status={queuedChipStatus(step)}
      domain="session"
      size="sm"
      label={step.gate?.short ?? "Queued"}
    />
  );
  if (!step.gate) return chip;
  return (
    <Tooltip label={`${enumLabel("jobType", step.jobType)} · ${step.gate.detail}`} multiline>
      {chip}
    </Tooltip>
  );
}

const PRIORITY_TONE: Record<IssuePriority, "red" | "amber" | "neutral"> = {
  critical: "red",
  high: "amber",
  medium: "neutral",
  low: "neutral",
  none: "neutral",
};

/** Read-only priority pill. `none` collapses to a muted dash. */
function PriorityCell({ priority }: { priority: IssuePriority }) {
  if (priority === "none")
    return <span className="fg-caption text-subtle">—</span>;
  return (
    <Badge tone={PRIORITY_TONE[priority]}>{priorityLabel(priority)}</Badge>
  );
}

/**
 * Build the flat list of menu items for a row's overflow ⋯ action. The current
 * value of each field is skipped so every item is an actual change. Labels are
 * prefixed (`Status:` / `Priority:` / …) so the flat list still reads clearly.
 */
function useRowMenuItems(
  row: IssueRow,
  actions: RowActions,
  open: () => void,
): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Open issue", icon: "arrowRight", onSelect: open },
  ];

  if (actions.canWrite === false) return items;

  if (heldByAgent(row.status, row.agentStatus)) {
    items.push({ label: AGENT_HOLDS_EDIT, disabled: true, separatorBefore: true });
    return items;
  }

  const grouped = groupedTransitions(row.status, row.workState?.leftStatus ?? null);
  const statusNames = transitionLabels(grouped.map((g) => g.to));
  for (const [i, g] of grouped.entries()) {
    items.push({
      label: `Status: ${statusNames[i]}`,
      danger: g.kind === "discard",
      separatorBefore: g.startsGroup,
      onSelect: () => actions.transition({ id: row.id, toStatus: g.to }),
    });
  }
  for (const p of ISSUE_PRIORITIES) {
    if (p === row.priority) continue;
    items.push({
      label: `Priority: ${priorityLabel(p)}`,
      onSelect: () => actions.patch({ id: row.id, body: { priority: p } }),
    });
  }
  for (const c of ISSUE_COMPLEXITIES) {
    if (c === row.complexity) continue;
    items.push({
      label: `Complexity: ${complexityLabel(c)}`,
      onSelect: () => actions.patch({ id: row.id, body: { complexity: c } }),
    });
  }
  if (row.complexity) {
    items.push({
      label: "Complexity: clear",
      onSelect: () => actions.patch({ id: row.id, body: { complexity: null } }),
    });
  }
  return items;
}

/** Overflow row-action menu (⋯). Disabled while a mutation is in flight. */
function RowMenu({
  row,
  actions,
  open,
}: {
  row: IssueRow;
  actions: RowActions;
  open: () => void;
}) {
  const items = useRowMenuItems(row, actions, open);
  return (
    <Menu
      align="right"
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

/** Who the row is with: the person it is assigned to, else the device a live agent run is on. */
export interface RowAssignee {
  label: string;
  agent: boolean;
}

function AssigneeCell({ assignee }: { assignee: RowAssignee | null }) {
  if (!assignee) return <span className="fg-caption text-subtle">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2" title={assignee.label}>
      {assignee.agent ? (
        <span className="inline-flex size-[22px] flex-none items-center justify-center rounded-pill bg-accent-tint text-accent-text">
          <Icon name="agent" size={13} />
        </span>
      ) : (
        <Avatar initials={initials(assignee.label)} size={22} />
      )}
      <span className="fg-caption truncate text-muted">{assignee.label}</span>
    </span>
  );
}

export function IssueTableRow({
  row,
  slug,
  actions,
  selection,
  assignee,
  now,
}: {
  row: IssueRow;
  slug: string;
  actions: RowActions;
  selection?: RowSelection;
  assignee: RowAssignee | null;
  /** One instant for the whole table, so the waiting figures on two rows are a
   *  comparison and not two independent readings of the clock. */
  now: number;
}) {
  const { open, pending } = useOpenIssue(slug, row.id);

  return (
    <TR
      className={`group cursor-pointer ${pending ? "opacity-60" : ""}`}
      aria-busy={pending}
      onClick={(e) => {
        // cm:why a click on the row opens the issue, but not one that lands on a control inside it (a chip's menu, the checkbox, the row menu)
        if ((e.target as HTMLElement).closest("button, a, input, [role=menu], [role=menuitem]")) return;
        open();
      }}
    >
      {selection && (
        <TD className="w-9 pr-0">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: wrapper only blocks bubbling; the Checkbox button is the control. */}
          <span
            className="inline-flex"
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selection.selected}
              onChange={selection.onToggle}
              disabled={actions.isPending}
              ariaLabel={`Select ${row.displayId}`}
            />
          </span>
        </TD>
      )}
      <TD className="w-px whitespace-nowrap" data-testid="issue-id-cell">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${row.displayId}`}
            className="cursor-pointer rounded-sm hover:opacity-80 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <MonoTag hue="cobalt">{row.displayId}</MonoTag>
          </button>
          {pending && <Spinner size={14} />}
        </span>
      </TD>
      <TD className="min-w-[280px] max-w-[560px]">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${row.displayId}: ${row.title}`}
            className="group/title min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="fg-body-sm block truncate text-fg group-hover/title:text-accent-text group-hover/title:underline">
              {row.title}
            </span>
          </button>
          <span className="flex flex-none items-center gap-1.5">
            {row.category && <EnumBadge family="category" value={row.category} />}
            <WaitingOnPersonChip since={row.waitingOnPersonSince} now={now} />
            <DepBadges deps={row.dependencies} slug={slug} />
          </span>
        </div>
      </TD>
      <TD>
        <StatusCell row={row} />
      </TD>
      <TD className="whitespace-nowrap">
        <PriorityCell priority={row.priority} />
      </TD>
      <TD className="max-w-[200px]">
        <AssigneeCell assignee={assignee} />
      </TD>
      <TD className="whitespace-nowrap">
        <LastWriteCell written={sinceLastWrite(row, now)} />
      </TD>
      <TD className="w-px text-right">
        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100">
          <RowMenu row={row} actions={actions} open={open} />
        </div>
      </TD>
    </TR>
  );
}
