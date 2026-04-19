import { useState, useMemo } from 'react';
import { View, Text, Pressable, SectionList, ScrollView, RefreshControl } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTasks, useUpdateTask } from '@/features/task/hooks';
import type { Task, TaskStatus } from '@/features/task/types';
import { TaskStatusBadge } from '@/components/ui/task-status-badge';
import { BottomSheetPicker } from '@/components/ui/bottom-sheet-picker';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { TaskBoardColumn } from '@/components/ui/task-board-column';

const STATUS_ORDER: TaskStatus[] = ['in_progress', 'in_review', 'todo', 'backlog', 'done'];
const STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: 'In Progress',
  in_review: 'In Review',
  todo: 'To Do',
  backlog: 'Backlog',
  done: 'Done',
};

const PICKER_OPTIONS = STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }));

export default function TasksScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, isLoading, isRefetching, refetch } = useTasks(slug);
  const updateTask = useUpdateTask();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selectedTask, setSelectedTask] = useState<{ id: string; status: TaskStatus } | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');

  const tasks = useMemo(() => data?.data || [], [data]);

  const sections = useMemo(() => {
    return STATUS_ORDER
      .map((status) => ({
        title: STATUS_LABELS[status],
        data: tasks.filter((t) => t.status === status),
      }))
      .filter((s) => s.data.length > 0);
  }, [tasks]);

  const columns = useMemo(() => {
    return STATUS_ORDER.map((status) => ({
      status,
      label: STATUS_LABELS[status],
      tasks: tasks.filter((t) => t.status === status),
    }));
  }, [tasks]);

  const openPicker = (task: Task) => {
    setSelectedTask({ id: task.documentId, status: task.status });
    setPickerVisible(true);
  };

  if (isLoading) return <View className="flex-1 items-center justify-center"><Spinner /></View>;
  if (!tasks.length) return <EmptyState icon="📋" title="No tasks" description="Tasks will appear here" />;

  return (
    <View className="flex-1 bg-white">
      {/* View toggle */}
      <View className="flex-row px-4 py-2 gap-2">
        <Pressable
          onPress={() => setViewMode('list')}
          className={`flex-1 py-2 rounded-lg items-center ${viewMode === 'list' ? 'bg-gray-900' : 'bg-gray-100'}`}
        >
          <Text className={`text-sm font-medium ${viewMode === 'list' ? 'text-white' : 'text-gray-600'}`}>
            List
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setViewMode('board')}
          className={`flex-1 py-2 rounded-lg items-center ${viewMode === 'board' ? 'bg-gray-900' : 'bg-gray-100'}`}
        >
          <Text className={`text-sm font-medium ${viewMode === 'board' ? 'text-white' : 'text-gray-600'}`}>
            Board
          </Text>
        </Pressable>
      </View>

      {viewMode === 'list' ? (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.documentId}
          renderSectionHeader={({ section }) => (
            <View className="px-4 py-2 bg-gray-50">
              <Text className="text-sm font-semibold text-gray-500">{section.title}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <Pressable className="flex-row items-center px-4 py-3 border-b border-gray-100">
              <Text className="flex-1 text-base text-gray-900" numberOfLines={1}>{item.title}</Text>
              <Pressable onPress={() => openPicker(item)}>
                <TaskStatusBadge status={item.status} />
              </Pressable>
              {item.issue?.title && (
                <Text className="text-sm text-gray-400 ml-2 max-w-[80px]" numberOfLines={1}>
                  {item.issue.title}
                </Text>
              )}
            </Pressable>
          )}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        />
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ padding: 12 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        >
          {columns.map((col) => (
            <TaskBoardColumn
              key={col.status}
              status={col.status}
              label={col.label}
              tasks={col.tasks}
              onTaskLongPress={openPicker}
            />
          ))}
        </ScrollView>
      )}

      <BottomSheetPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        title="Change Status"
        options={PICKER_OPTIONS}
        selectedValue={selectedTask?.status}
        onSelect={(value) => {
          if (selectedTask) {
            updateTask.mutate({ id: selectedTask.id, data: { status: value as TaskStatus } });
          }
        }}
      />
    </View>
  );
}
