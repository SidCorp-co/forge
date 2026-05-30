"use client";

// Inline-edit primitives shared by the table row + mobile card. `InlineSelect`
// commits a priority/complexity/assignee change (PATCH); `StatusEdit` shows the
// StatusChip and opens a status menu (transition — 409 surfaces as a toast via
// the mutation factory, the row value snaps back since nothing is invalidated).

import { Menu, NativeSelect, Select, StatusChip, type MenuItem, type SelectOption } from "@/design";
import { statusToChip } from "../derive";
import { ISSUE_STATUSES, type IssueAgentStatus, type IssueStatus } from "../types";

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
 * StatusChip that doubles as an inline status editor. Clicking opens a menu of
 * every lifecycle status; selecting one fires a transition. The full enum is
 * presented (there is no "allowed transitions" endpoint to pre-filter) — an
 * illegal transition 409s and is toasted by the caller's mutation.
 */
export function StatusEdit({ status, agentStatus, onTransition, disabled, size }: StatusEditProps) {
  const items: MenuItem[] = ISSUE_STATUSES.filter((s) => s !== status).map((s) => ({
    label: s,
    onSelect: () => onTransition(s),
  }));
  const chip = (
    <span className="inline-flex items-center gap-1">
      <StatusChip status={statusToChip(status, agentStatus)} size={size} />
      <span className="fg-caption font-mono">{status}</span>
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
