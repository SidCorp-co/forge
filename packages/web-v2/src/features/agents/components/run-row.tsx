"use client";

import { Icon, MonoTag } from "@/design";
import { TONE_META } from "@/design/status";
import { formatRelativeTime } from "@/lib/utils/format";
import { blockerText, closeMarks, runState, stateLabel } from "../run-state";
import type { RunSessionRow } from "../types";

function StateChip({ row }: { row: RunSessionRow }) {
  const meta = stateLabel(runState(row));
  const tone = TONE_META[meta.tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 font-semibold"
      style={{ color: tone.fg, background: tone.bg, fontSize: 11.5 }}
      title={meta.detail}
    >
      <span
        aria-hidden="true"
        className="size-[6px] rounded-pill"
        style={{ background: tone.dot }}
      />
      {meta.label}
    </span>
  );
}

/** The three marks, rendered as three. */
// cm:guard each mark gets its own element with its own text, and there is no "closed" rollup: a session that reached terminal while its worktree is still on disk is a recoverable diff, and the same pair with the tree gone is not — one badge for the pair loses exactly that (ISS-964 criterion 52).
function Marks({ row }: { row: RunSessionRow }) {
  const m = closeMarks(row);
  const items: Array<{ on: boolean; label: string }> = [
    { on: m.sessionTerminal, label: "session" },
    { on: m.worktreeGone, label: "worktree" },
  ];
  if (m.leasesReturned) {
    const { returned, total } = m.leasesReturned;
    items.push({ on: returned === total, label: `leases ${returned}/${total}` });
  }
  return (
    <span className="flex flex-none items-center gap-2">
      {items.map((i) => (
        <span
          key={i.label}
          className="fg-caption inline-flex items-center gap-1 whitespace-nowrap"
          style={{ color: i.on ? "var(--fg-muted)" : "var(--fg-subtle)" }}
        >
          <Icon name={i.on ? "check" : "clock"} size={12} aria-hidden="true" />
          {i.label}
        </span>
      ))}
    </span>
  );
}

export interface RunRowProps {
  row: RunSessionRow;
}

export function RunRow({ row }: RunRowProps) {
  const waiting = blockerText(row.blockerKind);
  const issues = row.issues ?? [];
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <StateChip row={row} />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {issues.length === 0 ? (
          <span className="fg-caption text-subtle">no issues on this run</span>
        ) : (
          issues.map((i) => <MonoTag key={i.issueKey}>{i.issueKey}</MonoTag>)
        )}
      </span>
      {waiting && (
        <span className="fg-caption flex-none whitespace-nowrap text-muted">
          waiting on {waiting}
        </span>
      )}
      <Marks row={row} />
      <span className="fg-caption hidden flex-none truncate text-subtle sm:inline sm:max-w-[9rem]">
        {row.deviceName ?? row.deviceId}
      </span>
      <span className="fg-caption flex-none whitespace-nowrap text-subtle">
        {formatRelativeTime(row.observedAt)}
      </span>
    </li>
  );
}
