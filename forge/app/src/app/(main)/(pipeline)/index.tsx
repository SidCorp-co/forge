import { useState, useCallback } from 'react';
import { View, Text, FlatList, Pressable, RefreshControl, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePipelineSessions, useCancelSession, useDeleteSession } from '@/features/pipeline/hooks';
import { FilterChip } from '@/components/ui/filter-chip';
import { Spinner } from '@/components/ui/spinner';
import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import type { PipelineSession, PipelineFilter } from '@/features/pipeline/types';

const STATUS_COLORS: Record<string, { border: string; dot: string; text: string }> = {
  queued: { border: '#f59e0b', dot: '#f59e0b', text: '#f59e0b' },
  running: { border: '#3b82f6', dot: '#3b82f6', text: '#3b82f6' },
  completed: { border: '#22c55e', dot: '#22c55e', text: '#22c55e' },
  failed: { border: '#ef4444', dot: '#ef4444', text: '#ef4444' },
  idle: { border: '#9ca3af', dot: '#9ca3af', text: '#9ca3af' },
};

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Success',
  failed: 'Failed',
  idle: 'Idle',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function duration(created: string, updated: string): string {
  const diff = new Date(updated).getTime() - new Date(created).getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export default function PipelineScreen() {
  const [filter, setFilter] = useState<PipelineFilter>('active');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data, isLoading, isRefetching, error, refetch } = usePipelineSessions(filter, autoRefresh);
  const cancelMutation = useCancelSession();
  const deleteMutation = useDeleteSession();

  const sessions = data?.data ?? [];
  const queuedCount = sessions.filter((s) => s.status === 'queued').length;
  const runningCount = sessions.filter((s) => s.status === 'running').length;
  const completedCount = sessions.filter((s) => s.status === 'completed').length;
  const failedCount = sessions.filter((s) => s.status === 'failed').length;
  const activeCount = queuedCount + runningCount;

  const onRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleCancel = useCallback(
    (documentId: string) => {
      Alert.alert('Cancel Session', 'Mark this session as failed?', [
        { text: 'No', style: 'cancel' },
        { text: 'Yes', style: 'destructive', onPress: () => cancelMutation.mutate(documentId) },
      ]);
    },
    [cancelMutation],
  );

  const handleDelete = useCallback(
    (documentId: string) => {
      Alert.alert('Delete Session', 'Delete this pipeline session?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate(documentId) },
      ]);
    },
    [deleteMutation],
  );

  const renderItem = useCallback(
    ({ item }: { item: PipelineSession }) => {
      const colors = STATUS_COLORS[item.status] ?? STATUS_COLORS.idle;
      const meta = item.metadata ?? {};
      const isActive = item.status === 'running' || item.status === 'queued';

      return (
        <View
          className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-3"
          style={{ borderLeftWidth: 3, borderLeftColor: colors.border }}
        >
          {/* Title & Status */}
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-sm font-semibold text-gray-900 flex-1 mr-3" numberOfLines={1}>
              {item.title}
            </Text>
            <View className="flex-row items-center gap-1.5">
              <Text style={{ color: colors.text, fontSize: 11, fontWeight: '600' }}>
                {STATUS_LABELS[item.status] ?? item.status}
              </Text>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: colors.dot,
                  ...(item.status === 'running'
                    ? { shadowColor: colors.dot, shadowOpacity: 0.8, shadowRadius: 4, elevation: 4 }
                    : {}),
                }}
              />
            </View>
          </View>

          {/* Metadata row */}
          <View className="flex-row flex-wrap gap-x-3 gap-y-1 mb-2">
            {item.project && (
              <Text className="text-xs text-gray-500">{item.project.name}</Text>
            )}
            {meta.skill && (
              <Text className="text-xs text-blue-600">{meta.skill}</Text>
            )}
            {(meta.deviceName || meta.runner) && (
              <Text className="text-xs text-gray-400">{meta.deviceName || meta.runner}</Text>
            )}
            {meta.fromStatus && meta.toStatus && (
              <Text className="text-xs text-gray-400">
                {meta.fromStatus} → {meta.toStatus}
              </Text>
            )}
            {item.issues?.map((iss) => (
              <Text key={iss.documentId} className="text-xs text-gray-400">
                ISS-{iss.id} ({iss.status})
              </Text>
            ))}
          </View>

          {/* Bottom row: timing + actions */}
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3">
              <Text className="text-xs text-gray-400 font-mono">
                {item.status !== 'queued'
                  ? duration(item.createdAt, item.updatedAt)
                  : timeAgo(item.createdAt)}
              </Text>
              {meta.retryCount != null && meta.retryCount > 0 && (
                <Text className="text-xs text-amber-600 font-mono">#{meta.retryCount}</Text>
              )}
            </View>

            <View className="flex-row items-center gap-2">
              {isActive && (
                <Pressable
                  onPress={() => handleCancel(item.documentId)}
                  className="px-2.5 py-1 rounded-md bg-red-50"
                >
                  <Text className="text-xs font-medium text-red-600">Cancel</Text>
                </Pressable>
              )}
              {(item.status === 'completed' || item.status === 'failed') && (
                <Pressable
                  onPress={() => handleDelete(item.documentId)}
                  className="px-2.5 py-1 rounded-md bg-gray-100"
                >
                  <Text className="text-xs font-medium text-gray-500">Delete</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      );
    },
    [handleCancel, handleDelete],
  );

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <Spinner size="large" />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-white p-4">
        <AlertBanner type="error" message={error.message ?? 'Failed to load pipeline sessions'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      {/* Hero Section */}
      <View className="px-4 pt-2 pb-3">
        <View className="flex-row items-end justify-between mb-3">
          <View>
            <Text className="text-4xl font-black text-gray-900">{activeCount}</Text>
            <Text className="text-sm text-gray-500 font-medium">Active</Text>
          </View>
          <View className="flex-row items-center gap-4">
            <View className="items-center">
              <Text className="text-lg font-mono font-semibold text-blue-600">{runningCount}</Text>
              <Text className="text-[10px] text-gray-400 uppercase tracking-wider">Run</Text>
            </View>
            <View className="items-center">
              <Text className="text-lg font-mono font-semibold text-green-600">{completedCount}</Text>
              <Text className="text-[10px] text-gray-400 uppercase tracking-wider">Done</Text>
            </View>
            <View className="items-center">
              <Text className="text-lg font-mono font-semibold text-red-500">{failedCount}</Text>
              <Text className="text-[10px] text-gray-400 uppercase tracking-wider">Fail</Text>
            </View>
          </View>
        </View>

        {/* Controls row */}
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row gap-2">
            <FilterChip label="Active" active={filter === 'active'} onPress={() => setFilter('active')} />
            <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-gray-400">Live</Text>
            <Switch
              value={autoRefresh}
              onValueChange={setAutoRefresh}
              trackColor={{ false: '#e5e7eb', true: '#3b82f6' }}
              thumbColor="#fff"
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
        </View>
      </View>

      {/* Session List */}
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.documentId}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <EmptyState icon="⚡" title="No pipeline sessions" description={filter === 'active' ? 'All systems idle' : 'No pipeline activity yet'} />
        }
      />
    </SafeAreaView>
  );
}
