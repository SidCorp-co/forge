// The dashboard's headline actionable block: a compact, prioritized digest of
// the cross-project Attention inbox (`useAttention`). Shows the highest-signal
// items first (failures → reviews → awaiting input → offline runners →
// mentions), caps the list so the dashboard stays dense, and links each row to
// its source. Empty → a quiet "all clear" state.
import { Card, CardContent, Icon, type IconName, MonoTag } from '@/design';
import { formatRelativeTime } from '@/features/projects/derive';
import type { AttentionItem, AttentionKind, AttentionView } from '@/features/attention/types';

const KIND_META: Record<AttentionKind, { label: string; icon: IconName; fg: string; bg: string }> = {
  failed_job: { label: 'Failed', icon: 'alert', fg: 'var(--red-600)', bg: 'var(--red-50)' },
  needs_review: { label: 'Review', icon: 'check', fg: 'var(--cobalt-700)', bg: 'var(--cobalt-50)' },
  awaiting_input: { label: 'Awaiting', icon: 'clock', fg: 'var(--amberw-600)', bg: 'var(--amberw-50)' },
  runner_offline: { label: 'Offline', icon: 'server', fg: 'var(--red-600)', bg: 'var(--red-50)' },
  mention: { label: 'Mention', icon: 'mail', fg: 'var(--cobalt-700)', bg: 'var(--cobalt-50)' },
};

const MAX_ROWS = 6;

/** Highest-signal first — the order the digest surfaces items in. */
function prioritized(view: AttentionView): AttentionItem[] {
  return [
    ...view.failedJobs,
    ...view.needsReview,
    ...view.awaitingInput,
    ...view.offlineRunners,
    ...view.mentions,
  ];
}

function KindTag({ kind }: { kind: AttentionKind }) {
  const m = KIND_META[kind];
  return (
    <span
      className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 font-semibold"
      style={{ color: m.fg, background: m.bg, fontSize: 11 }}
    >
      <Icon name={m.icon} size={12} style={{ color: m.fg }} />
      {m.label}
    </span>
  );
}

export function AttentionPanel({
  view,
  now,
  onOpen,
  onViewAll,
}: {
  view: AttentionView;
  now: number;
  onOpen: (link: string) => void;
  onViewAll: () => void;
}) {
  const items = prioritized(view);
  const shown = items.slice(0, MAX_ROWS);
  const overflow = items.length - shown.length;

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="inbox" size={16} className="text-subtle" />
          <h3 className="fg-h3">Needs attention</h3>
          {view.total > 0 && (
            <span
              className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
              style={{ fontSize: 11, lineHeight: '16px', color: 'var(--accent-text)', background: 'var(--flame-50)' }}
            >
              {view.total}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="fg-caption inline-flex items-center gap-1 rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          View all
          <Icon name="arrowRight" size={13} />
        </button>
      </div>

      <CardContent className="flex-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 py-7 text-center">
            <span
              className="inline-flex size-9 items-center justify-center rounded-pill"
              style={{ background: 'var(--green-50)' }}
            >
              <Icon name="check" size={18} style={{ color: 'var(--green-600)' }} />
            </span>
            <p className="fg-body-sm font-semibold text-fg">All clear</p>
            <p className="fg-caption text-subtle">Nothing needs your attention right now.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {shown.map((it, i) => (
              <button
                key={`${it.kind}-${it.link}-${i}`}
                type="button"
                onClick={() => onOpen(it.link)}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                <KindTag kind={it.kind} />
                <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{it.title}</span>
                {it.issueRef && <MonoTag>{it.issueRef}</MonoTag>}
                <span className="fg-caption hidden flex-none text-subtle sm:inline">
                  {formatRelativeTime(it.since, now)}
                </span>
                <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
              </button>
            ))}
            {overflow > 0 && (
              <button
                type="button"
                onClick={onViewAll}
                className="fg-caption mt-0.5 rounded-sm py-1 text-left text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                +{overflow} more in Attention →
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
