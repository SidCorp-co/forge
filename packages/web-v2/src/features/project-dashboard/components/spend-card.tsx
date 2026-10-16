// 7-day spend by kind of work (ISS-379, AC#4). Pure-CSS stacked bar of the three costliest + Other, a
// legend, `+$X in flight` where runs are still spending, and the figure against its own normal.
import { formatUsd } from "@/lib/utils/format";
import type { SpendByStepData } from "../derive";
import type { ReadState } from "../shape";
import { DashboardSection, EmptyLine, unreadSection } from "./dashboard-section";

export function SpendCard({
  data,
  inFlightUsd,
  read,
}: {
  data: SpendByStepData;
  inFlightUsd: number;
  /** The step-durations read the spend is summed from; until it is in, "none recorded" is not said. */
  read?: ReadState;
}) {
  const { segments, total } = data;
  const unread = unreadSection("7-day spend", "The 7-day spend", read);
  if (unread) return unread;
  if (total === 0) {
    return (
      <EmptyLine
        title="7-day spend"
        status="none recorded"
        detail={inFlightUsd > 0 ? `+${formatUsd(inFlightUsd)} in flight` : undefined}
      />
    );
  }
  return (
    <DashboardSection
      title="7-day spend"
      aside={<span className="font-mono text-sm font-semibold tabular-nums text-fg">{formatUsd(total)}</span>}
    >
      <div className="flex h-2 w-full overflow-hidden rounded-pill bg-[var(--paper-200)]">
        {segments.map((s) => (
          <span key={s.key} title={`${s.label} · ${formatUsd(s.cost)}`} style={{ width: `${s.pct}%`, background: s.color }} />
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: s.color }} />
            <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{s.label}</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-fg">{formatUsd(s.cost)}</span>
          </li>
        ))}
      </ul>
      {inFlightUsd > 0 && <p className="fg-caption mt-2 text-subtle">+{formatUsd(inFlightUsd)} in flight</p>}
    </DashboardSection>
  );
}
