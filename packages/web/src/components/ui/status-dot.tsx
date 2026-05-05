import { cn } from '@/lib/utils/cn';

const STATUS_DOT_COLORS: Record<string, string> = {
  queued: 'bg-violet-500',
  running: 'bg-success animate-pulse',
  stalled: 'bg-amber-500 animate-pulse',
  completed: 'bg-surface-bright',
  failed: 'bg-danger',
};

export function StatusDot({ status, title }: { status: string; title?: string }) {
  const color = STATUS_DOT_COLORS[status] ?? 'bg-surface-variant';
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full', color)}
      title={title}
    />
  );
}
