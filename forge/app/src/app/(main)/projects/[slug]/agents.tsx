import { useCallback } from 'react';
import { View, Text, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useAgents, useAgentSessions, useDesktopStatus, useAgentReview, useAgentReindex } from '@/features/agent/hooks';
import { AgentCard } from '@/components/agent/agent-card';
import { Spinner } from '@/components/ui/spinner';
import type { Agent } from '@/features/agent/types';

export default function AgentsScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data: agentsData, isLoading: agentsLoading, isRefetching, refetch } = useAgents(slug);
  const { data: sessionsData } = useAgentSessions(slug);
  const { data: desktopData } = useDesktopStatus();
  const reviewMutation = useAgentReview(slug);
  const reindexMutation = useAgentReindex(slug);

  const agents = agentsData?.data ?? [];
  const sessions = sessionsData?.data ?? [];
  const desktopConnected = desktopData?.data?.connected ?? false;

  const handleReview = useCallback(
    (agentType: string) => reviewMutation.mutateAsync(agentType),
    [reviewMutation],
  );

  const handleReindex = useCallback(
    (agentType: string) => reindexMutation.mutateAsync(agentType),
    [reindexMutation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Agent }) => (
      <AgentCard
        agent={item}
        sessions={sessions}
        onReview={handleReview}
        onReindex={handleReindex}
      />
    ),
    [sessions, handleReview, handleReindex],
  );

  if (agentsLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      {/* Desktop status banner */}
      <View className={`px-4 py-2 ${desktopConnected ? 'bg-green-50' : 'bg-amber-50'}`}>
        <Text className={`text-sm ${desktopConnected ? 'text-green-700' : 'text-amber-700'}`}>
          {desktopConnected ? 'Desktop agent connected' : 'Desktop agent offline'}
        </Text>
      </View>

      <FlatList
        data={agents}
        keyExtractor={(item) => item.documentId}
        renderItem={renderItem}
        contentContainerClassName="px-4 pt-3 pb-20"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <View className="items-center mt-10">
            <Text className="text-gray-400 text-base">No agents configured</Text>
            <Text className="text-gray-400 text-sm mt-1">Configure agents in the web dashboard</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}
