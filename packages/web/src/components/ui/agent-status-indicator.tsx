import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import type { AgentSessionDisplayStatus } from '@/features/agent/api';
import type { AgentStatus } from '@/features/task/types';

type IndicatorStatus = AgentStatus | AgentSessionDisplayStatus | null;

// Path strings are 20×20 viewBox glyphs matching the original SVG set.
const QUEUED_PATH =
  'M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z';
const STALLED_PATH =
  'M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a1 1 0 011 1v3a1 1 0 11-2 0V7a1 1 0 011-1zm0 7a1 1 0 100 2 1 1 0 000-2z';
const COMPLETED_PATH =
  'M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z';
const FAILED_PATH =
  'M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z';

const ICON_SET: Partial<
  Record<NonNullable<IndicatorStatus>, { d: string; cls: string; label: string }>
> = {
  queued: {
    d: QUEUED_PATH,
    cls: 'h-3.5 w-3.5 animate-pulse text-violet-500 dark:text-violet-400',
    label: 'queued',
  },
  stalled: {
    d: STALLED_PATH,
    cls: 'h-3.5 w-3.5 text-amber-500 dark:text-amber-400',
    label: 'stalled',
  },
  completed: {
    d: COMPLETED_PATH,
    cls: 'h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400',
    label: 'completed',
  },
  failed: {
    d: FAILED_PATH,
    cls: 'h-3.5 w-3.5 text-red-500 dark:text-red-400',
    label: 'failed',
  },
};

export function AgentStatusIndicator({ status }: { status: IndicatorStatus }) {
  if (!status || status === 'idle') return null;
  if (status === 'running') return <AgentRunningDot size="md" />;

  const icon = ICON_SET[status] ?? ICON_SET.failed;
  if (!icon) return null;
  return (
    <svg className={icon.cls} viewBox="0 0 20 20" fill="currentColor" aria-label={icon.label}>
      <path fillRule="evenodd" d={icon.d} clipRule="evenodd" />
    </svg>
  );
}
