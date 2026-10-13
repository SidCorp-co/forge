// 7-day spend-by-stage (ISS-379, AC#4). Pure-CSS stacked bar (test / code / plan / other) + per-stage
// legend, `+$X in flight` where runs are still spending, and the figure against its own normal.
import { formatUsd } from "@/features/pipeline/derive";
import type { SpendByStageData } from "../derive";
import { DashboardSection, EmptyLine } from "./dashboard-section";

export function SpendCard({ data, inFlightUsd }: { data: SpendByStageData; inFlightUsd: number }) {
  const { segments, total } = data;
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
            <span className="fg-body-sm min-w-0 flex-1 truncate lowercase text-fg">{s.label}</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-fg">{formatUsd(s.cost)}</span>
          </li>
        ))}
      </ul>
      {inFlightUsd > 0 && <p className="fg-caption mt-2 text-subtle">+{formatUsd(inFlightUsd)} in flight</p>}
    </DashboardSection>
  );
}
