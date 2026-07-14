// "What just changed that I should care about" — recently-updated issues
// across every in-scope project (ISS-665, replaces the raw chat-log activity
// feed). Project tag · status dot · ISS ref · title · relative time, each row
// clickable to the issue detail.
import { Card, CardContent, EmptyState, ErrorState, Icon, MonoTag, Skeleton } from '@/design';
import { STATUS_META } from '@/design/status';
import { statusToChip } from '@/features/issues/derive';
import { formatApiError } from '@/lib/api/error';
import { formatRelativeTime } from '@/features/projects/derive';
import type { RecentChangeItem } from '@/features/recent-changes/types';

export function RecentChanges({
  items,
  now,
  isLoading,
  isError,
  error,
  onOpen,
  onRetry,
}: {
  items: RecentChangeItem[];
  now: number;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onOpen: (slug: string, id: string) => void;
  onRetry: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="activity" size={16} className="text-subtle" />
          <h3 className="fg-h3">Recent changes</h3>
        </div>
      </div>
      <CardContent className="flex-1">
        {isError ? (
          <ErrorState
            title="Couldn't load recent changes"
            message={formatApiError(error)}
            onRetry={onRetry}
          />
        ) : isLoading ? (
          <ul className="flex flex-col">
            {Array.from({ length: 4 }, (_, i) => (
              <li
                key={i}
                className="flex items-center gap-2.5 border-b border-line-subtle py-2 last:border-0"
              >
                <Skeleton variant="circle" className="size-1.5" />
                <Skeleton className="h-5 w-16 rounded-pill" />
                <Skeleton className="h-5 w-12 rounded-pill" />
                <Skeleton variant="text" className="min-w-0 flex-1" />
                <Skeleton className="h-3 w-10" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <EmptyState
            mascot={false}
            message="No recent changes — updated issues will show up here."
          />
        ) : (
          <ul className="flex flex-col">
            {items.map((row) => {
              const dot = STATUS_META[statusToChip(row.status)].dot;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(row.projectSlug, row.id)}
                    className="flex w-full items-center gap-2.5 border-b border-line-subtle py-2 text-left last:border-0 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <span
                      aria-hidden
                      className="inline-block size-1.5 flex-none rounded-full"
                      style={{ background: dot }}
                    />
                    <MonoTag hue="cobalt">{row.projectSlug}</MonoTag>
                    <MonoTag>{`ISS-${row.issSeq}`}</MonoTag>
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{row.title}</span>
                    <span className="fg-caption flex-none font-mono text-subtle">
                      {formatRelativeTime(row.updatedAt, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
