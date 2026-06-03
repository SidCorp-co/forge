// Compact recent cross-project activity — the last few agent Q&A turns from the
// `useActivity` feed. Project slug · query snippet · relative time.
// Presentational: rows + states are passed in. (The standalone workspace
// Activity page was removed in ISS-359, so `onViewAll` is optional now — when
// omitted the header shows no "View all" link.)
import { Card, CardContent, Icon, MonoTag } from '@/design';
import { formatRelativeTime } from '@/features/projects/derive';
import type { ChatLogRow } from '@/features/activity/types';

export function ActivityFeed({
  rows,
  now,
  isLoading,
  onOpen,
  onViewAll,
}: {
  rows: ChatLogRow[];
  now: number;
  isLoading: boolean;
  onOpen: (slug: string) => void;
  onViewAll?: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="activity" size={16} className="text-subtle" />
          <h3 className="fg-h3">Recent activity</h3>
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="fg-caption inline-flex items-center gap-1 rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            View all
            <Icon name="arrowRight" size={13} />
          </button>
        )}
      </div>
      <CardContent className="flex-1">
        {isLoading ? (
          <p className="fg-body-sm py-6 text-center text-subtle">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-subtle">No activity yet.</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onOpen(row.projectSlug)}
                  className="flex w-full items-center gap-2.5 border-b border-line-subtle py-2 text-left last:border-0 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  <MonoTag hue="cobalt">{row.projectSlug}</MonoTag>
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{row.query}</span>
                  <span className="fg-caption flex-none font-mono text-subtle">
                    {formatRelativeTime(row.createdAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
