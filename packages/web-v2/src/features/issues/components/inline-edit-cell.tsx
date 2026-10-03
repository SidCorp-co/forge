"use client";

// Inline-edit primitives shared by the table row + mobile card. `InlineSelect`
// commits a priority/complexity/assignee change (PATCH); `StatusEdit` shows the
// StatusChip and opens a status menu (transition — 409 surfaces as a toast via
// the mutation factory, the row value snaps back since nothing is invalidated).

import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import { Menu, NativeSelect, Select, StatusChip, type MenuItem, type SelectOption } from "@/design";
import { groupedTransitions, issueStatusChip, statusLabel, transitionLabels } from "../derive";
import { AGENT_HOLDS_MOVE, heldByAgent } from "../edit-lock";
import { useStatusExits } from "../hooks";
import type { ParkReading } from "../derive";
import { type ParkMenuActions, parkMenuItems } from "../park";
import type { IssueAgentStatus, IssueStatus } from "../types";

interface InlineSelectProps {
  value: string;
  options: SelectOption[];
  onCommit: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Use the OS-native picker (mobile cards). */
  native?: boolean;
  className?: string;
}

/** Compact always-editable select for a single issue field. */
export function InlineSelect({
  value,
  options,
  onCommit,
  disabled,
  ariaLabel,
  native,
  className,
}: InlineSelectProps) {
  if (native) {
    return (
      <NativeSelect
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        options={options}
        className={className}
        onChange={(e) => {
          const next = e.target.value;
          if (next !== value) onCommit(next);
        }}
      />
    );
  }
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      options={options}
      className={className}
      onChange={(next) => {
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/** The map's own moves from this rung, or the one inert line that says why there are none. */
function ordinaryItems(args: {
  status: IssueStatus;
  grouped: ReturnType<typeof groupedTransitions>;
  isPending: boolean;
  isError: boolean;
  onTransition: (toStatus: IssueStatus) => void;
}): MenuItem[] {
  const { status, grouped, isPending, isError, onTransition } = args;
  if (isPending) return [{ label: "Loading status moves…", disabled: true }];
  if (isError) return [{ label: "Couldn't load status moves", disabled: true }];
  if (grouped.length === 0) {
    return [{ label: `No move from ${statusLabel(status)} — re-file instead`, disabled: true }];
  }
  const names = transitionLabels(grouped.map((g) => g.to));
  return grouped.map((g, i) => ({
    label: names[i],
    danger: g.kind === "discard",
    separatorBefore: g.startsGroup,
    onSelect: () => onTransition(g.to),
  }));
}

interface StatusEditProps {
  status: IssueStatus;
  /** The run's step inside `in_progress` (`workState.step`), which the chip names where it has one. */
  step?: WorkStep | null;
  /** The status a park left (`workState.leftStatus`), which the menu offers to return to. */
  leftStatus?: IssueStatus | null;
  agentStatus?: IssueAgentStatus;
  onTransition: (toStatus: IssueStatus) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** On the issue page: what a person owes this issue, so a park offers its decision first (ISS-1310). */
  park?: { reading: ParkReading; actions: ParkMenuActions };
}

/**
 * StatusChip that doubles as an inline status editor. The menu offers the moves
 * the RUNG has — core's exits row for this status, read over the pipeline
 * registry — forward move first, then the bounces, then the discards. A rung
 * with no exit says so rather than opening empty (ISS-982).
 */
export function StatusEdit({
  status,
  step,
  leftStatus = null,
  agentStatus,
  onTransition,
  disabled,
  size,
  park,
}: StatusEditProps) {
  const { exits, isPending, isError } = useStatusExits();
  const grouped = groupedTransitions(exits, status, leftStatus);
  const held = heldByAgent(status, agentStatus);
  let items: MenuItem[];
  if (held) {
    items = [{ label: AGENT_HOLDS_MOVE, disabled: true }];
  } else {
    items = ordinaryItems({ status, grouped, isPending, isError, onTransition });
    const mapRead = !isPending && !isError;
    const parkItems = park
      ? parkMenuItems({
          status,
          leftStatus,
          reading: park.reading,
          exits: mapRead ? (exits ?? {}) : undefined,
          ordinary: items,
          actions: park.actions,
        })
      : null;
    if (parkItems) items = parkItems;
  }
  const chip = <StatusChip {...issueStatusChip(status, step)} size={size} />;
  if (disabled) return chip;
  return (
    <Menu
      align="left"
      items={items}
      trigger={
        <button
          type="button"
          aria-label={`Change status (currently ${statusLabel(status)})`}
          className="inline-flex min-h-11 items-center rounded-md px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {chip}
        </button>
      }
    />
  );
}
