// Open-issues-by-state ring (ISS-379, AC#4). Pure-CSS conic-gradient ring + legend rows — no chart
// lib. The legend adds up to the ring's centre (ISS-1156). Flat: no card around it.
import { OPEN_WORK_LABEL } from "@forge/contracts/work-state";
import { conicGradient, type StatusDonutData } from "../derive";
import { DashboardSection, EmptyLine } from "./dashboard-section";

export function StatusDonut({ data }: { data: StatusDonutData }) {
  const { segments, total } = data;
  const title = `${OPEN_WORK_LABEL} by state`;
  if (total === 0) return <EmptyLine title={title} status="no open work to chart" />;
  return (
    <DashboardSection title={title}>
      <div className="flex items-center gap-5 py-1">
        <div
          className="relative size-[112px] flex-none rounded-full"
          style={{ background: conicGradient(segments) }}
          role="img"
          aria-label={`${OPEN_WORK_LABEL} by state, ${total} total`}
        >
          <div className="absolute inset-[14px] flex flex-col items-center justify-center rounded-full bg-surface">
            <span className="font-mono text-xl font-bold tabular-nums text-fg">{total}</span>
            <span className="fg-caption text-subtle">{OPEN_WORK_LABEL.toLowerCase()}</span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {segments.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 flex-none rounded-sm" style={{ background: s.color }} />
              <span className="fg-body-sm min-w-0 flex-1 text-fg">{s.label}</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-fg">{s.count}</span>
              <span className="fg-caption w-10 text-right tabular-nums text-subtle">{Math.round(s.pct)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </DashboardSection>
  );
}
