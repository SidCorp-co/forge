import { STATUS_COLORS } from '@/lib/colors';
import type { IssueStatus } from '@/features/issue/types';
import { ColorBadge } from './color-badge';

const LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  approved: 'Approved',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  reopen: 'Reopen',
  failed: 'Failed',
  needs_info: 'Needs Info',
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  const colors = STATUS_COLORS[status];
  return <ColorBadge label={LABELS[status]} bg={colors.bg} text={colors.text} />;
}
