import { useState, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIssues } from '@/features/issue/hooks';
import { IssueCard } from '@/components/issue/issue-card';
import { FilterChip } from '@/components/ui/filter-chip';
import { ALL_STATUSES, ALL_PRIORITIES } from '@/lib/colors';
import type { IssueStatus, IssuePriority } from '@/features/issue/types';

export default function IssuesScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data, isLoading, isRefetching, refetch } = useIssues(slug);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<IssueStatus | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | null>(null);

  const issues = useMemo(() => {
    let list = data?.data ?? [];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((i) => i.title.toLowerCase().includes(q));
    }
    if (statusFilter) list = list.filter((i) => i.status === statusFilter);
    if (priorityFilter) list = list.filter((i) => i.priority === priorityFilter);
    return list;
  }, [data, search, statusFilter, priorityFilter]);

  const renderItem = useCallback(
    ({ item }: { item: (typeof issues)[0] }) => (
      <IssueCard
        issue={item}
        onPress={() => router.push(`/projects/${slug}/issues/${item.documentId}`)}
      />
    ),
    [router, slug],
  );

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      <View className="px-4 pt-3 pb-2 gap-2">
        <TextInput
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          placeholder="Search issues..."
          value={search}
          onChangeText={setSearch}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-1.5">
            <FilterChip label="All" active={!statusFilter} onPress={() => setStatusFilter(null)} />
            {ALL_STATUSES.map((s) => (
              <FilterChip
                key={s.value}
                label={s.label}
                active={statusFilter === s.value}
                onPress={() => setStatusFilter(statusFilter === s.value ? null : s.value)}
              />
            ))}
          </View>
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-1.5">
            <FilterChip label="All" active={!priorityFilter} onPress={() => setPriorityFilter(null)} />
            {ALL_PRIORITIES.map((p) => (
              <FilterChip
                key={p.value}
                label={p.label}
                active={priorityFilter === p.value}
                onPress={() => setPriorityFilter(priorityFilter === p.value ? null : p.value)}
              />
            ))}
          </View>
        </ScrollView>
      </View>

      <FlatList
        data={issues}
        keyExtractor={(item) => item.documentId}
        renderItem={renderItem}
        contentContainerClassName="px-4 pb-20"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <Text className="text-center text-gray-400 mt-10">No issues found</Text>
        }
      />

      <Pressable
        className="absolute bottom-6 right-6 w-14 h-14 bg-gray-900 rounded-full items-center justify-center shadow-lg"
        onPress={() => router.push(`/projects/${slug}/issues/new`)}
      >
        <Text className="text-white text-2xl font-light">+</Text>
      </Pressable>
    </SafeAreaView>
  );
}
