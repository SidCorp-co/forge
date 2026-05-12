'use client';

import { cn } from '@/lib/utils/cn';

export type TimelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface TimelineStep {
  key: string;
  label: string;
  status: TimelineStepStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  clickable?: boolean;
}

export interface TimelineProps {
  steps: TimelineStep[];
  currentKey?: string;
  onStepClick?: (key: string) => void;
  className?: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} m`;
  return `${(ms / 3_600_000).toFixed(2)} h`;
}

function tooltipText(step: TimelineStep): string {
  const lines: string[] = [`${step.label} — ${step.status}`];
  if (step.startedAt) {
    lines.push(`Started: ${new Date(step.startedAt).toLocaleString()}`);
  }
  if (step.finishedAt) {
    lines.push(`Finished: ${new Date(step.finishedAt).toLocaleString()}`);
  }
  if (typeof step.durationMs === 'number') {
    lines.push(`Duration: ${formatMs(step.durationMs)}`);
  }
  return lines.join('\n');
}

const STATUS_STYLE: Record<
  TimelineStepStatus,
  { pill: string; dot: string }
> = {
  completed: {
    pill: 'bg-primary/15 text-primary border-primary/30',
    dot: 'bg-primary',
  },
  running: {
    pill: 'bg-surface-container border-primary text-primary',
    dot: 'bg-primary animate-pulse',
  },
  pending: {
    pill: 'bg-surface-container border-outline-variant/30 text-outline',
    dot: 'bg-outline-variant/40',
  },
  failed: {
    pill: 'bg-error/10 border-error/40 text-error',
    dot: 'bg-error',
  },
  skipped: {
    pill: 'bg-surface-container border-outline-variant/20 text-outline-variant line-through',
    dot: 'bg-outline-variant/30',
  },
};

export function Timeline({ steps, currentKey, onStepClick, className }: TimelineProps) {
  return (
    <ol
      data-testid="pipeline-timeline"
      className={cn(
        'flex w-full items-center gap-1 overflow-x-auto rounded-sm border border-outline-variant/20 bg-surface px-3 py-2',
        className,
      )}
    >
      {steps.map((step, idx) => {
        const isCurrent = currentKey === step.key;
        const style = STATUS_STYLE[step.status];
        const isClickable = !!step.clickable && !!onStepClick;
        const Tag: 'button' | 'div' = isClickable ? 'button' : 'div';
        return (
          <li key={step.key} className="flex flex-1 items-center gap-1 min-w-fit">
            <Tag
              type={isClickable ? 'button' : undefined}
              onClick={isClickable ? () => onStepClick?.(step.key) : undefined}
              disabled={isClickable ? false : undefined}
              aria-label={`Pipeline step ${step.label}, status ${step.status}`}
              aria-current={isCurrent ? 'step' : undefined}
              title={tooltipText(step)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors',
                style.pill,
                isCurrent && 'ring-1 ring-primary/40',
                isClickable && 'cursor-pointer hover:bg-surface-container-high',
                !isClickable && 'cursor-default',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
              <span>{step.label}</span>
            </Tag>
            {idx < steps.length - 1 && (
              <span
                aria-hidden
                className="h-px flex-1 min-w-2 bg-outline-variant/30"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default Timeline;
