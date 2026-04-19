import { Clock, Loader2, CheckCircle, XCircle } from 'lucide-react';

export interface PipelineSession {
  id: number;
  documentId: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'idle';
  createdAt: string;
  updatedAt: string;
  metadata: {
    type?: string;
    skill?: string;
    runner?: string;
    fromStatus?: string;
    toStatus?: string;
    retryCount?: number;
    deviceId?: string;
    deviceName?: string;
    antigravityRunnerName?: string;
    noResume?: boolean;
    startedAt?: string;
    quotaExhaustedAt?: string;
    depletedModel?: string;
  } | null;
  project: { id: number; documentId: string; name: string; slug: string } | null;
  issues: Array<{ id: number; documentId: string; title: string; status: string }>;
}

export const STATUS_ICON: Record<string, typeof Clock> = {
  queued: Clock,
  running: Loader2,
  completed: CheckCircle,
  failed: XCircle,
};

export const STATUS_CONFIG: Record<string, { label: string; dotClass: string; textClass: string; borderClass: string }> = {
  queued: {
    label: 'Queued',
    dotClass: 'bg-warning',
    textClass: 'text-warning',
    borderClass: 'border-l-warning',
  },
  running: {
    label: 'Running',
    dotClass: 'bg-info shadow-[0_0_8px_var(--color-info)]',
    textClass: 'text-info',
    borderClass: 'border-l-info',
  },
  completed: {
    label: 'Success',
    dotClass: 'bg-success',
    textClass: 'text-success',
    borderClass: 'border-l-success',
  },
  failed: {
    label: 'Failed',
    dotClass: 'bg-error',
    textClass: 'text-error',
    borderClass: 'border-l-error',
  },
};

export function timeAgo(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
