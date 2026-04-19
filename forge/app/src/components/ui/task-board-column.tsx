import { View, Text, FlatList } from 'react-native';
import type { Task, TaskStatus } from '@/features/task/types';
import { TaskBoardCard } from './task-board-card';

interface TaskBoardColumnProps {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  onTaskLongPress: (task: Task) => void;
}

export function TaskBoardColumn({ label, tasks, onTaskLongPress }: TaskBoardColumnProps) {
  return (
    <View className="w-72 bg-white rounded-xl border border-gray-200 mr-3" style={{ maxHeight: '100%' }}>
      <View className="flex-row items-center justify-between px-3 py-2.5 border-b border-gray-100">
        <Text className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
          {label}
        </Text>
        <View className="bg-gray-100 rounded-full px-2 py-0.5">
          <Text className="text-xs font-medium text-gray-600">{tasks.length}</Text>
        </View>
      </View>
      <FlatList
        data={tasks}
        keyExtractor={(item) => item.documentId}
        renderItem={({ item }) => (
          <TaskBoardCard task={item} onLongPress={() => onTaskLongPress(item)} />
        )}
        contentContainerStyle={{ padding: 8 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
