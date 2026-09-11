"use client";

// Inline-edit primitives shared by the table row + mobile card. `InlineSelect`
// commits a priority/complexity/assignee change (PATCH); `StatusEdit` shows the
// StatusChip and opens a status menu (transition — 409 surfaces as a toast via
// the mutation factory, the row value snaps back since nothing is invalidated).

import { Menu, NativeSelect, Select, StatusChip, type MenuItem, type SelectOption } from "@/design";
import { groupedTransitions, statusToChip, transitionLabels } from "../derive";
import { useStatusExits } from "../hooks";
import { useStatusLabeller } from "../vocabulary";
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

interface StatusEditProps {
  status: IssueStatus;
  agentStatus?: IssueAgentStatus;
  onTransition: (toStatus: IssueStatus) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}

/**
 * StatusChip that doubles as an inline status editor. The menu offers the moves
 * the RUNG has — core's exits row for this status, read over the pipeline
 * registry — forward move first, then the bounces, then the discards. A rung
 * with no exit says so rather than opening empty (ISS-982).
 */
// cm:guard the three no-target states are DISTINCT lines and must stay so: "loading", "could not load" and "no exits at all" are three different things for the person holding the mouse, and collapsing them renders ordinary latency as a failure and a terminal issue as a broken menu
export function StatusEdit({ status, agentStatus, onTransition, disabled, size }: StatusEditProps) {
  const statusLabel = useStatusLabeller();
  const { exits, isPending, isError } = useStatusExits();
  const grouped = groupedTransitions(exits, status);
  let items: MenuItem[];
  if (isPending) {
    items = [{ label: "Loading status moves…", disabled: true }];
  } else if (isError) {
    items = [{ label: "Couldn't load status moves", disabled: true }];
  } else if (grouped.length === 0) {
    items = [{ label: `No move from ${statusLabel(status)} — re-file instead`, disabled: true }];
  } else {
    const names = transitionLabels(
      grouped.map((g) => g.to),
      statusLabel,
    );
    items = grouped.map((g, i) => ({
      label: names[i],
      danger: g.kind === "discard",
      separatorBefore: g.startsGroup,
      onSelect: () => onTransition(g.to),
    }));
  }
  const chip = (
    <span className="inline-flex items-center gap-1">
      <StatusChip status={statusToChip(status, agentStatus)} size={size} />
      <span className="fg-caption">{statusLabel(status)}</span>
    </span>
  );
  if (disabled) return chip;
  return (
    <Menu
      align="left"
      items={items}
      trigger={
        <button
          type="button"
          aria-label={`Change status (currently ${status})`}
          className="inline-flex min-h-11 items-center rounded-md px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {chip}
        </button>
      }
    />
  );
}
