'use client';

import { cn } from '@/lib/utils/cn';
import { STATUS_COLORS, PRIORITY_COLORS } from '@/lib/constants';

interface HistoryBadgeProps {
  field: string;
  value: string | null | undefined;
}

export function HistoryBadge({ field, value }: HistoryBadgeProps) {
  if (field === 'status') {
    return (
      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_COLORS[value as keyof typeof STATUS_COLORS] ?? 'bg-surface-container-high text-on-surface-variant')}>
        {value ?? 'none'}
      </span>
    );
  }
  if (field === 'priority') {
    return (
      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', PRIORITY_COLORS[value as keyof typeof PRIORITY_COLORS] ?? 'bg-surface-container-high text-on-surface-variant')}>
        {value ?? 'none'}
      </span>
    );
  }
  return <span className="rounded bg-surface-container-high px-1 py-0.5">{value ?? 'none'}</span>;
}
