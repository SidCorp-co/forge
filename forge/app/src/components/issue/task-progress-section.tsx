import { View, Text, FlatList } from 'react-native';
import { TaskStatusBadge } from '@/components/ui/task-status-badge';
import type { TaskStatus } from '@/features/task/types';

interface TaskItem {
  title: string;
  status: string;
}

interface TaskProgressSectionProps {
  tasks: TaskItem[];
}

export function TaskProgressSection({ tasks }: TaskProgressSectionProps) {
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.status === 'done').length;

  return (
    <View className="mt-4">
      <Text className="text-base font-semibold text-gray-900 mb-2">Tasks</Text>
      <Text className="text-sm text-gray-500 mb-2">
        {done} of {tasks.length} tasks done
      </Text>
      <View className="h-2 bg-gray-200 rounded-full mb-3">
        <View
          className="h-2 bg-green-500 rounded-full"
          style={{ width: tasks.length > 0 ? `${(done / tasks.length) * 100}%` : '0%' }}
        />
      </View>
      <FlatList
        data={tasks}
        scrollEnabled={false}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <View className="flex-row items-center justify-between py-1.5">
            <Text className="flex-1 text-sm text-gray-700" numberOfLines={1}>{item.title}</Text>
            <TaskStatusBadge status={item.status as TaskStatus} />
          </View>
        )}
      />
    </View>
  );
}
