import { cn } from '@/lib/utils/cn';

const STATUS_DOT_COLORS: Record<string, string> = {
  queued: 'bg-warning',
  running: 'bg-success animate-pulse',
  completed: 'bg-surface-bright',
  failed: 'bg-danger',
};

export function StatusDot({ status }: { status: string }) {
  const color = STATUS_DOT_COLORS[status] ?? 'bg-surface-variant';
  return <span className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}
