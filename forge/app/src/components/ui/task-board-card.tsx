import { View, Text, Pressable } from 'react-native';
import type { Task } from '@/features/task/types';
import { PriorityBadge } from './priority-badge';

interface TaskBoardCardProps {
  task: Task;
  onLongPress: () => void;
}

export function TaskBoardCard({ task, onLongPress }: TaskBoardCardProps) {
  return (
    <Pressable
      onLongPress={onLongPress}
      className="bg-gray-50 rounded-lg p-3 mb-2"
    >
      <Text className="text-sm font-medium text-gray-900 mb-1" numberOfLines={1}>
        {task.title}
      </Text>
      <View className="flex-row items-center justify-between">
        <PriorityBadge priority={task.priority} />
        {task.assignee && (
          <View className="w-6 h-6 rounded-full bg-indigo-100 items-center justify-center">
            <Text className="text-xs font-semibold text-indigo-600">
              {task.assignee.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
