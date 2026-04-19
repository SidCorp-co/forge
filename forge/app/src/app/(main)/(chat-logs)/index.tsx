import { useState, useCallback } from 'react';
import { View, Text, TextInput, FlatList, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useChatLogs } from '@/features/chat-log/hooks';
import { FilterChip } from '@/components/ui/filter-chip';
import { Spinner } from '@/components/ui/spinner';
import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import type { ChatLog, ChatLogFilters } from '@/features/chat-log/types';

const STATUS_OPTIONS = ['all', 'completed', 'failed'] as const;

function getChatStatus(log: ChatLog): 'completed' | 'failed' | 'running' {
  if (log.error) return 'failed';
  if (log.reply) return 'completed';
  return 'running';
}

const STATUS_STYLES = {
  completed: { bg: '#dcfce7', text: '#166534' },
  failed: { bg: '#fee2e2', text: '#991b1b' },
  running: { bg: '#dbeafe', text: '#1e40af' },
} as const;

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ChatLogsScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  const filters: ChatLogFilters = { page, pageSize: 25 };

  const { data, isLoading, isRefetching, error, refetch } = useChatLogs(filters);

  const onRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  const filtered = (data?.data ?? []).filter((log) => {
    if (search) {
      const q = search.toLowerCase();
      if (!log.query.toLowerCase().includes(q) && !log.projectSlug.toLowerCase().includes(q)) {
        return false;
      }
    }
    if (statusFilter !== 'all') {
      const status = getChatStatus(log);
      if (status !== statusFilter) return false;
    }
    return true;
  });

  const handleEndReached = useCallback(() => {
    if (data && page < data.meta.pagination.pageCount) {
      setPage((p) => p + 1);
    }
  }, [data, page]);

  const renderItem = useCallback(({ item }: { item: ChatLog }) => {
    const status = getChatStatus(item);
    const style = STATUS_STYLES[status];
    return (
      <Pressable
        className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-3"
        onPress={() => router.push(`/(main)/chat-logs/${item.documentId}`)}
      >
        <View className="flex-row items-center justify-between mb-2">
          <Text className="text-xs text-gray-500 font-medium">{item.projectSlug}</Text>
          <View style={{ backgroundColor: style.bg, borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ color: style.text, fontSize: 11, fontWeight: '600' }}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Text>
          </View>
        </View>
        <Text className="text-sm font-medium text-gray-900 mb-2" numberOfLines={2}>
          {item.query}
        </Text>
        <View className="flex-row items-center justify-between">
          <Text className="text-xs text-gray-400">{formatDate(item.createdAt)}</Text>
          {item.model && (
            <Text className="text-xs text-gray-400">{item.model}</Text>
          )}
        </View>
      </Pressable>
    );
  }, [router]);

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
        <AlertBanner type="error" message={error.message ?? 'Failed to load chat logs'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="px-4 pt-2 pb-3">
        <Text className="text-2xl font-bold mb-3">Chat Logs</Text>

        <TextInput
          className="bg-gray-100 rounded-lg px-3 py-2.5 text-sm mb-3"
          placeholder="Search by query or project..."
          placeholderTextColor="#9ca3af"
          value={search}
          onChangeText={setSearch}
        />

        <View className="flex-row flex-wrap gap-2">
          {STATUS_OPTIONS.map((s) => (
            <FilterChip
              key={s}
              label={s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              active={statusFilter === s}
              onPress={() => setStatusFilter(s)}
            />
          ))}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.documentId}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={<EmptyState icon="💬" title="No chat logs" description="Chat sessions will appear here" />}
      />
    </SafeAreaView>
  );
}
