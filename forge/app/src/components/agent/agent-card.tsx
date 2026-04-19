import { useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { Button } from '@/components/ui/button';
import type { Agent, AgentSession } from '@/features/agent/types';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusColors: Record<string, string> = {
  idle: 'bg-gray-400',
  queued: 'bg-yellow-400',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
};

interface AgentCardProps {
  agent: Agent;
  sessions: AgentSession[];
  onReview: (agentType: string) => Promise<unknown>;
  onReindex: (agentType: string) => Promise<unknown>;
}

export function AgentCard({ agent, sessions, onReview, onReindex }: AgentCardProps) {
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reindexLoading, setReindexLoading] = useState(false);

  const recentSessions = sessions
    .filter((s) => s.title?.toLowerCase().includes(agent.type.toLowerCase()) || true)
    .slice(0, 5);

  const handleReview = async () => {
    setReviewLoading(true);
    try {
      await onReview(agent.type);
      Alert.alert('Review started', `Review session triggered for ${agent.name}`);
    } catch {
      Alert.alert('Error', 'Failed to start review');
    } finally {
      setReviewLoading(false);
    }
  };

  const handleReindex = async () => {
    setReindexLoading(true);
    try {
      await onReindex(agent.type);
      Alert.alert('Reindex started', `Reindex session triggered for ${agent.name}`);
    } catch {
      Alert.alert('Error', 'Failed to start reindex');
    } finally {
      setReindexLoading(false);
    }
  };

  return (
    <View className="bg-white border border-gray-200 rounded-xl p-4 mb-3">
      {/* Header */}
      <View className="flex-row items-center mb-2">
        <View className={`w-2.5 h-2.5 rounded-full mr-2 ${agent.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
        <Text className="text-base font-semibold text-gray-900 flex-1" numberOfLines={1}>
          {agent.name}
        </Text>
        <View className="bg-gray-100 px-2 py-0.5 rounded">
          <Text className="text-xs text-gray-600">{agent.type}</Text>
        </View>
      </View>

      {/* Description */}
      {agent.definition?.description && (
        <Text className="text-sm text-gray-500 mb-3" numberOfLines={2}>
          {agent.definition.description}
        </Text>
      )}

      {/* Meta */}
      <View className="flex-row gap-3 mb-3">
        <Text className="text-xs text-gray-400">Schedule: {agent.schedule}</Text>
        <Text className="text-xs text-gray-400">Mode: {agent.approvalMode}</Text>
      </View>

      {/* Actions */}
      <View className="flex-row gap-2 mb-3">
        <Button
          title={reviewLoading ? 'Starting...' : 'Review'}
          variant="secondary"
          size="sm"
          onPress={handleReview}
          disabled={reviewLoading || reindexLoading}
        />
        <Button
          title={reindexLoading ? 'Starting...' : 'Reindex'}
          variant="secondary"
          size="sm"
          onPress={handleReindex}
          disabled={reviewLoading || reindexLoading}
        />
      </View>

      {/* Recent Sessions */}
      {recentSessions.length > 0 && (
        <View>
          <Text className="text-xs font-medium text-gray-500 mb-1.5">Recent Sessions</Text>
          {recentSessions.map((session) => (
            <View key={session.documentId} className="flex-row items-center py-1.5 border-t border-gray-100">
              <View className={`w-2 h-2 rounded-full mr-2 ${statusColors[session.status] ?? 'bg-gray-400'}`} />
              <Text className="text-sm text-gray-700 flex-1" numberOfLines={1}>
                {session.title || 'Untitled session'}
              </Text>
              <Text className="text-xs text-gray-400">{timeAgo(session.updatedAt)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
