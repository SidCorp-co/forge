"use client";

import type { IssueMove } from "@forge/contracts/issue-machine";
// Inline-edit primitives shared by the table row + mobile card. `InlineSelect`
// commits a priority/complexity/assignee change (PATCH); `StatusEdit` shows the
// StatusBadge and opens a status menu (transition — 409 surfaces as a toast via
// the mutation factory, the row value snaps back since nothing is invalidated).

import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import { Menu, NativeSelect, Select, StatusBadge, type MenuItem, type SelectOption } from "@/design";
import { statusLabel, transitionLabels } from "../derive";
import { AGENT_HOLDS_MOVE, heldByAgent } from "../edit-lock";
import { useStatusTone } from "../release-approval";
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
      quiet
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
  grouped: readonly IssueMove[];
  onTransition: (toStatus: IssueStatus) => void;
}): MenuItem[] {
  const { status, grouped, onTransition } = args;
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
  /** Core's moves from this status (`IssueStanding.moves`, a list row's `moves`), forward first. */
  moves: readonly IssueMove[];
  agentStatus?: IssueAgentStatus;
  onTransition: (toStatus: IssueStatus) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** On the issue page: what a person owes this issue, so a park offers its decision first (ISS-1310). */
  park?: { reading: ParkReading; actions: ParkMenuActions };
}

/**
 * StatusBadge that doubles as an inline status editor. The menu offers the moves
 * the RUNG has — the issue machine's exits for this status — forward move first, then the bounces, then the discards. A rung
 * with no exit says so rather than opening empty (ISS-982).
 */
export function StatusEdit({
  status,
  step,
  moves,
  agentStatus,
  onTransition,
  disabled,
  size,
  park,
}: StatusEditProps) {
  const tone = useStatusTone(status);
  const grouped = moves;
  const held = heldByAgent(status, agentStatus);
  let items: MenuItem[];
  if (held) {
    items = [{ label: AGENT_HOLDS_MOVE, disabled: true }];
  } else {
    items = ordinaryItems({ status, grouped, onTransition });
    const parkItems = park
      ? parkMenuItems({
          status,
          moves,
          reading: park.reading,
          ordinary: items,
          actions: park.actions,
        })
      : null;
    if (parkItems) items = parkItems;
  }
  const chip = <StatusBadge family="issue" value={status} step={step} tone={tone} size={size} />;
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
