import { FlatList, Pressable, Text, View } from 'react-native';
import { StatusBadge } from '@/components/ui/status-badge';
import { relativeTime } from '@/lib/format';
import type { Issue } from '@/features/issue/types';

interface RecentActivityProps {
  issues: Issue[];
  onPress: (issue: Issue) => void;
}

export function RecentActivity({ issues, onPress }: RecentActivityProps) {
  const recent = issues.slice(0, 8);

  return (
    <FlatList
      data={recent}
      keyExtractor={(item) => item.documentId}
      scrollEnabled={false}
      contentContainerClassName="px-4 gap-2"
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onPress(item)}
          className="flex-row items-center justify-between py-2 border-b border-gray-100"
        >
          <Text className="flex-1 mr-3 text-sm" numberOfLines={1}>
            {item.title}
          </Text>
          <View className="flex-row items-center gap-2">
            <StatusBadge status={item.status} />
            <Text className="text-xs text-gray-400 w-14 text-right">
              {relativeTime(item.updatedAt)}
            </Text>
          </View>
        </Pressable>
      )}
      ListEmptyComponent={
        <Text className="text-gray-400 text-center py-4">No recent issues</Text>
      }
    />
  );
}
