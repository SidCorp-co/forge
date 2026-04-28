import { View, Text, Pressable } from 'react-native';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { PriorityBadge } from '@/components/ui/priority-badge';
import { AgentRunningDot } from '@/components/ui/agent-running-dot';
import { relativeTime } from '@/lib/format';
import type { Issue } from '@/features/issue/types';

interface IssueCardProps {
  issue: Issue;
  onPress: () => void;
}

export function IssueCard({ issue, onPress }: IssueCardProps) {
  return (
    <Pressable onPress={onPress}>
      <Card className="mb-2">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 font-semibold text-gray-900" numberOfLines={1}>
            {issue.title}
          </Text>
          <StatusBadge status={issue.status} />
          <PriorityBadge priority={issue.priority} />
        </View>
        <View className="flex-row items-center gap-2 mt-1">
          <Text className="text-xs text-gray-500">{relativeTime(issue.createdAt)}</Text>
          {issue.agentStatus === 'running' && <AgentRunningDot />}
        </View>
      </Card>
    </Pressable>
  );
}
