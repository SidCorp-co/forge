'use client';

import { Bell, Sparkles } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import { useAttentionQueue } from '../hooks/use-attention-queue';
import type { AttentionItem } from '../types';
import { AttentionCard } from './attention-card';

const BUCKETS: Array<{
  key: 'needsReview' | 'awaitingInput' | 'mentions' | 'failedJobs';
  label: string;
}> = [
  { key: 'needsReview', label: 'Needs review' },
  { key: 'awaitingInput', label: 'Awaiting your input' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'failedJobs', label: 'Failed jobs' },
];

export function AttentionQueue() {
  const { data, isLoading, error } = useAttentionQueue();

  if (isLoading) {
    return (
      <section className="space-y-2">
        <Header total={null} />
        <Skeleton className="h-24" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-2">
        <Header total={null} />
        <div className="rounded-sm border border-error/30 bg-error-container/10 p-3 text-xs text-error">
          {formatApiError(error)}
        </div>
      </section>
    );
  }

  const total = data?.total ?? 0;

  if (total === 0) {
    return (
      <section className="space-y-2">
        <Header total={0} />
        <p className="flex items-center gap-2 rounded-sm border border-outline-variant/20 bg-surface-container-low p-3 text-xs text-outline">
          <Sparkles className="h-3.5 w-3.5" />
          All caught up — nothing needs your attention.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <Header total={total} />
      <div className="space-y-3">
        {BUCKETS.map((b) => {
          const items = (data?.[b.key] ?? []) as AttentionItem[];
          if (items.length === 0) return null;
          return (
            <div key={b.key} className="space-y-1">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
                {b.label} ({items.length})
              </h3>
              <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
                {items.map((it, idx) => (
                  <li key={`${b.key}-${idx}`}>
                    <AttentionCard item={it} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Header({ total }: { total: number | null }) {
  return (
    <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
      <Bell className="h-3.5 w-3.5" />
      Items that need your attention
      {total != null && (
        <span className="ml-auto text-[10px] uppercase tracking-widest text-outline">
          {total} item{total === 1 ? '' : 's'}
        </span>
      )}
    </h2>
  );
}

export default AttentionQueue;
