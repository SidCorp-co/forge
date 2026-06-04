// 7-day spend-by-stage card (ISS-379, AC#4). Pure-CSS stacked bar (test / code /
// plan / other) + per-stage legend + `+$X in flight` annotation. The over-time
// trend graph is deferred to ISS-380 Part 1 (bucketed endpoints) — shown as a
// quiet "coming soon" footer rather than a fake chart.
import { Card, CardContent, Icon } from "@/design";
import { formatUsd } from "@/features/pipeline/derive";
import type { SpendByStageData } from "../derive";

export function SpendCard({ data, inFlightUsd }: { data: SpendByStageData; inFlightUsd: number }) {
  const { segments, total } = data;
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="dollar" size={16} className="text-subtle" />
          <h3 className="fg-h3">7-day spend</h3>
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums text-fg">{formatUsd(total)}</span>
      </div>
      <CardContent className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No spend recorded in the last 7 days.</p>
        ) : (
          <>
            <div className="flex h-2.5 w-full overflow-hidden rounded-pill bg-[var(--paper-200)]">
              {segments.map((s) => (
                <span
                  key={s.key}
                  title={`${s.label} · ${formatUsd(s.cost)}`}
                  style={{ width: `${s.pct}%`, background: s.color }}
                />
              ))}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5">
              {segments.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="size-2.5 flex-none rounded-sm" style={{ background: s.color }} />
                  <span className="fg-body-sm min-w-0 flex-1 truncate lowercase text-fg">{s.label}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-fg">{formatUsd(s.cost)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="fg-caption mt-3 border-t border-line-subtle pt-2.5 text-subtle">
          {inFlightUsd > 0 ? `+${formatUsd(inFlightUsd)} in flight · ` : ""}
          Cost-over-time trend coming soon (ISS-380)
        </p>
      </CardContent>
    </Card>
  );
}
