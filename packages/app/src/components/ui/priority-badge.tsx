import { PRIORITY_COLORS } from '@/lib/colors';
import type { IssuePriority } from '@/features/issue/types';
import { ColorBadge } from './color-badge';

const LABELS: Record<IssuePriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
};

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  const colors = PRIORITY_COLORS[priority];
  return <ColorBadge label={LABELS[priority]} bg={colors.bg} text={colors.text} />;
}
