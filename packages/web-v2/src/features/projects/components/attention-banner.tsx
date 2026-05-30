'use client';

// Needs-attention banner: surfaces the count of projects with blocked runs or
// offline runners, and toggles the attention-only filter.
import { Banner, Button } from '@/design';

export interface AttentionBannerProps {
  count: number;
  attentionOnly: boolean;
  onToggle: () => void;
}

export function AttentionBanner({ count, attentionOnly, onToggle }: AttentionBannerProps) {
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
