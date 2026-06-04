// Open-issues-by-status donut (ISS-379, AC#4). Pure-CSS conic-gradient ring +
// legend — no chart lib. Light-first (kit color tokens).
import { Card, CardContent, Icon } from "@/design";
import { conicGradient, type StatusDonutData } from "../derive";

export function StatusDonut({ data }: { data: StatusDonutData }) {
  const { segments, total } = data;
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line-subtle px-5 py-3.5">
        <Icon name="board" size={16} className="text-subtle" />
        <h3 className="fg-h3">Open issues by status</h3>
      </div>
      <CardContent className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No open issues to chart.</p>
        ) : (
          <div className="flex items-center gap-5">
            <div
              className="relative size-[112px] flex-none rounded-full"
              style={{ background: conicGradient(segments) }}
              role="img"
              aria-label={`Open issues by status, ${total} total`}
            >
              <div className="absolute inset-[18px] flex flex-col items-center justify-center rounded-full bg-surface">
                <span className="font-mono text-xl font-bold tabular-nums text-fg">{total}</span>
                <span className="fg-caption text-subtle">open</span>
              </div>
            </div>
            <ul className="min-w-0 flex-1 space-y-1.5">
              {segments.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="size-2.5 flex-none rounded-sm" style={{ background: s.color }} />
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{s.label}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-fg">{s.count}</span>
                  <span className="fg-caption w-10 text-right tabular-nums text-subtle">
                    {Math.round(s.pct)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
