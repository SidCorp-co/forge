'use client';

// Needs-attention banner: surfaces the count of projects with blocked runs or
// offline runners, and toggles the attention-only filter. Where the health
// rollup is not read, it says so: no banner would read as no project needing attention.
import { Banner, Button } from '@/design';
import type { QueryRead } from '@/design/patterns/badge-read';

export interface AttentionBannerProps {
  count: number;
  /** What the health rollup answered; a count is stated only where it is `read`. */
  read: QueryRead;
  attentionOnly: boolean;
  onToggle: () => void;
  onRetry: () => void;
}

export function AttentionBanner({ count, read, attentionOnly, onToggle, onRetry }: AttentionBannerProps) {
  if (read !== 'read') {
    return (
      <div className="mb-4" role="status">
        <Banner
          tone={read === 'failed' ? 'attention' : 'info'}
          action={
            read === 'failed' ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {read === 'failed'
            ? 'Which projects need attention could not be read, so no figure below is a count. Retry to read it again.'
            : 'Reading which projects need attention…'}
        </Banner>
      </div>
    );
  }
  if (count === 0) return null;
  return (
    <div className="mb-4">
      <Banner
        tone="attention"
        action={
          <Button variant="ghost" size="sm" onClick={onToggle}>
            {attentionOnly ? 'Show all' : 'Show only these'}
          </Button>
        }
      >
        <strong className="font-semibold">
          {count} {count === 1 ? 'project' : 'projects'}
        </strong>{' '}
        need attention — blocked runs or offline runners.
      </Banner>
    </div>
  );
}
