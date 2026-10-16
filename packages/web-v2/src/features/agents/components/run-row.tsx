"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, MonoTag, SILENCE_TONE } from "@/design";
import { TONE_META } from "@/design/status";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  blockerText,
  closeMarks,
  disagreement,
  disagreementText,
  endReasonText,
  pendingReasonText,
  silenceText,
  stateLabelAt,
} from "../run-state";
import type { RunSessionRow } from "../types";

function StateChip({ row, now }: { row: RunSessionRow; now: number }) {
  const meta = stateLabelAt(row, now);
  const tone = TONE_META[meta.tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 self-start whitespace-nowrap rounded-pill px-2 py-0.5 font-semibold sm:self-auto"
      style={{ color: tone.fg, background: tone.bg, fontSize: "var(--text-11-5)" }}
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
        <span key={l} className="truncate" style={l === silence ? { color: TONE_META[SILENCE_TONE].fg } : undefined}>
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
  /** The project the run belongs to, so each issue key links to its page. */
  slug: string;
}

/** Who can end the wait and what the run waits on, in the box's own words; the questions tab is a
 *  link beside it rather than a paraphrase in its place. */
function WaitingOn({ row }: { row: RunSessionRow }) {
  const who = blockerText(row.blockerKind);
  const pathname = usePathname() || "";
  if (!who) return null;
  return (
    <span className="fg-caption flex min-w-0 flex-wrap items-baseline gap-x-2 text-muted sm:max-w-[24rem]">
      <span className="min-w-0 break-words">
        {row.waitingOn ? `Waiting on ${who} — ${row.waitingOn}` : `Waiting on ${who}`}
      </span>
      {row.waitingOn && row.blockerKind === "human" && (
        <Link
          href={`${pathname}?tab=questions&q=${encodeURIComponent(row.waitingOn)}`}
          className="flex-none underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          Open questions
        </Link>
      )}
    </span>
  );
}

export function RunRow({ row, now, slug }: RunRowProps) {
  const issues = row.issues ?? [];
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <StateChip row={row} now={now} />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {issues.length === 0 ? (
          <span className="fg-caption text-subtle">no issues on this run</span>
        ) : (
          issues.map((i) => (
            <Link
              key={i.issueKey}
              href={`/projects/${slug}/issues/${encodeURIComponent(i.issueKey)}`}
              className="flex-none hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <MonoTag>{i.issueKey}</MonoTag>
            </Link>
          ))
        )}
      </span>
      <WaitingOn row={row} />
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
