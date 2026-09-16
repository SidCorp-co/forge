"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, MonoTag } from "@/design";
import { TONE_META } from "@/design/status";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  blockerText,
  closeMarks,
  disagreement,
  disagreementText,
  endReasonText,
  pendingReasonText,
  runState,
  silenceText,
  stateLabel,
} from "../run-state";
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

/** What core's own heartbeat says, where it disagrees with the chip beside it. */
function CoreReading({ row, now }: { row: RunSessionRow; now: number }) {
  const silence = silenceText(row, now);
  const split = disagreement(row);
  const ended = endReasonText(row);
  const note = pendingReasonText(row);
  const lines = [silence, split && disagreementText(split), ended, note].filter(
    Boolean,
  ) as string[];
  if (lines.length === 0) return null;
  return (
    <span className="fg-caption flex min-w-0 flex-col gap-0.5 text-muted sm:flex-none sm:text-right">
      {lines.map((l) => (
        <span key={l} className="truncate">
          {l}
        </span>
      ))}
    </span>
  );
}

export interface RunRowProps {
  row: RunSessionRow;
  /** One clock for the whole list, so two rows never grade the same instant differently. */
  now: number;
}

export function RunRow({ row, now }: RunRowProps) {
  const waiting = blockerText(row.blockerKind);
  const issues = row.issues ?? [];
  const pathname = usePathname() || "";
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
      {waiting &&
        (row.waitingOn ? (
          <Link
            href={`${pathname}?tab=questions&q=${encodeURIComponent(row.waitingOn)}`}
            className="fg-caption flex-none whitespace-nowrap text-muted underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            waiting on {waiting} — read the decision
          </Link>
        ) : (
          <span className="fg-caption flex-none whitespace-nowrap text-muted">
            waiting on {waiting}
          </span>
        ))}
      <CoreReading row={row} now={now} />
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
