// "Where does the work sit" — a single horizontal stacked bar of the workspace
// issue distribution, folded into 6 pipeline buckets (backlog → blocked) with a
// counted legend. Built from the aggregated `statusDistribution` across all
// project health rows; closed/draft are excluded (see `groupWorkBuckets`).
import { Card, CardContent, Icon } from '@/design';
import type { WorkBucket } from '../derive';

export function WorkDistribution({
  buckets,
  total,
}: {
  buckets: WorkBucket[];
  total: number;
}) {
  const active = buckets.filter((b) => b.count > 0);

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="board" size={16} className="text-subtle" />
          <h3 className="fg-h3">Work distribution</h3>
        </div>
        <span className="font-mono text-[12.5px] text-subtle">{total} in flight</span>
      </div>

      <CardContent className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-subtle">No in-flight work right now.</p>
        ) : (
          <>
            {/* Stacked bar */}
            <div className="flex h-2.5 w-full overflow-hidden rounded-pill bg-[var(--paper-200)]">
              {active.map((b) => (
                <span
                  key={b.key}
                  className="h-full first:rounded-l-pill last:rounded-r-pill"
                  style={{ width: `${(b.count / total) * 100}%`, background: b.color }}
                  title={`${b.label}: ${b.count}`}
                />
              ))}
            </div>

            {/* Legend — only non-empty buckets, counts in mono. */}
            <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
              {active.map((b) => (
                <li key={b.key} className="flex items-center gap-2">
                  <span
                    className="size-2.5 flex-none rounded-[3px]"
                    style={{ background: b.color }}
                    aria-hidden
                  />
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{b.label}</span>
                  <span className="font-mono text-[12.5px] font-semibold text-subtle">{b.count}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
