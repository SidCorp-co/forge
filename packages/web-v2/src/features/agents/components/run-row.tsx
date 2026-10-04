"use client";

import type { RunStanding } from "@forge/contracts/run-standing";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, MonoTag, StatusBadge, ToneBadge } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  blockerText,
  closeMarks,
  endReasonText,
  pendingReasonText,
  runState,
  stateLabel,
} from "../run-state";
import type { RunSessionRow } from "../types";

function BoxChip({ row }: { row: RunSessionRow }) {
  const s = runState(row);
  const meta = stateLabel(s);
  return (
    <ToneBadge
      tone={meta.tone}
      label={meta.label}
      value={s}
      title={`box ${row.incarnation} × ${row.work}: ${meta.detail}`}
    />
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

function StuckLine({ standing }: { standing: RunStanding | null }) {
  const stuck = standing?.stuck;
  if (stuck?.source !== "stuck") return null;
  const tip = [stuck.detail, `evidence: ${stuck.evidence.table}.${stuck.evidence.column} (${stuck.evidence.id})`, stuck.failsBy].join("\n");
  return (
    <span className="truncate" title={tip}>
      {enumLabel("runStuckRule", stuck.rule)} since {formatRelativeTime(stuck.since)}
    </span>
  );
}

function CoreReading({ row, standing }: { row: RunSessionRow; standing: RunStanding | null }) {
  const ended = endReasonText(row);
  const note = pendingReasonText(row);
  const lines = [ended, note].filter(Boolean) as string[];
  const stuck = standing?.stuck.source === "stuck";
  if (lines.length === 0 && !stuck) return null;
  return (
    <span className="fg-caption flex min-w-0 flex-col gap-0.5 text-muted sm:flex-none sm:text-right">
      <StuckLine standing={standing} />
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
  standing: RunStanding | null;
}

export function RunRow({ row, standing }: RunRowProps) {
  const waiting = blockerText(row.blockerKind);
  const issues = row.issues ?? [];
  const pathname = usePathname() || "";
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      {standing ? <StatusBadge family="runStanding" value={standing.state} /> : null}
      <BoxChip row={row} />
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
      <CoreReading row={row} standing={standing} />
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
