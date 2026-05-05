import { cn } from '@/lib/utils/cn';

// `stalled` is a synthetic UI-only state derived from heartbeat freshness
// (see `deriveSessionDisplayStatus` in features/agent/api.ts). The amber
// pulse separates "claimed but quiet" from "actively streaming" (green
// pulse) so the user can spot a hung worker at a glance.
const STATUS_DOT_COLORS: Record<string, string> = {
  queued: 'bg-violet-500 animate-pulse',
  running: 'bg-success animate-pulse',
  stalled: 'bg-amber-500 animate-pulse',
  completed: 'bg-surface-bright',
  failed: 'bg-danger',
};

export function StatusDot({ status, title }: { status: string; title?: string }) {
  const color = STATUS_DOT_COLORS[status] ?? 'bg-surface-variant';
  return <span title={title} className={cn('inline-block h-2 w-2 rounded-full', color)} />;
}
