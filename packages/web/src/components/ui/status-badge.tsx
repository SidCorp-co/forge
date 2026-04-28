import { cn } from '@/lib/utils/cn';
import { STATUS_COLORS } from '@/lib/constants';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('rounded-sm px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider', STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? 'bg-surface-variant text-outline')}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
