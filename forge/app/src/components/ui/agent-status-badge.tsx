import { AGENT_STATUS_COLORS } from '@/lib/colors';
import type { AgentStatus } from '@/features/task/types';
import { ColorBadge } from './color-badge';

const LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const colors = AGENT_STATUS_COLORS[status];
  return <ColorBadge label={LABELS[status]} bg={colors.bg} text={colors.text} />;
}
