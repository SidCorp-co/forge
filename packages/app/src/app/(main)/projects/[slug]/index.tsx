import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useProject } from '@/features/project/hooks';
import { useIssues } from '@/features/issue/hooks';
import { useTasks } from '@/features/task/hooks';
import { StatsRow } from '@/components/dashboard/stats-row';
import { ProjectHeader } from '@/components/layout/project-header';
import { SectionHeading } from '@/components/ui/section-heading';
import { StatusBadge } from '@/components/ui/status-badge';
import { TaskStatusBadge } from '@/components/ui/task-status-badge';
import { Card } from '@/components/ui/card';

const QUICK_ACTIONS = [
  { key: 'issues', label: 'Issues', icon: '🐛', path: 'issues' },
  { key: 'tasks', label: 'Tasks', icon: '✓', path: 'tasks' },
  { key: 'chat', label: 'Chat', icon: '💬', path: 'chat' },
  { key: 'agent', label: 'Agent', icon: '⚡', path: 'agent' },
  { key: 'agents', label: 'Agents', icon: '🤖', path: 'agents' },
  { key: 'skills', label: 'Skills', icon: '🧩', path: 'skills' },
  { key: 'knowledge', label: 'Knowledge', icon: '📚', path: 'knowledge' },
  { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings' },
] as const;

export default function ProjectOverview() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const project = useProject(slug);
  const issues = useIssues(slug);
  const tasks = useTasks(slug);
  const { refetch: refetchProject } = project;
  const { refetch: refetchIssues } = issues;
  const { refetch: refetchTasks } = tasks;

  const isRefreshing = project.isRefetching || issues.isRefetching || tasks.isRefetching;

  const onRefresh = useCallback(() => {
    refetchProject();
    refetchIssues();
    refetchTasks();
  }, [refetchProject, refetchIssues, refetchTasks]);

  const allIssues = issues.data?.data ?? [];
  const allTasks = tasks.data?.data ?? [];

  const issueStats = useMemo(() => [
    { label: 'Open', value: allIssues.filter((i) => i.status === 'open').length, accentColor: '#f59e0b' },
    { label: 'In Progress', value: allIssues.filter((i) => i.status === 'in_progress').length, accentColor: '#8b5cf6' },
    { label: 'Resolved', value: allIssues.filter((i) => i.status === 'resolved').length, accentColor: '#10b981' },
  ], [allIssues]);

  const taskStats = useMemo(() => [
    { label: 'Backlog', value: allTasks.filter((t) => t.status === 'backlog').length },
    { label: 'To Do', value: allTasks.filter((t) => t.status === 'todo').length, accentColor: '#3b82f6' },
    { label: 'In Progress', value: allTasks.filter((t) => t.status === 'in_progress').length, accentColor: '#f59e0b' },
    { label: 'Done', value: allTasks.filter((t) => t.status === 'done').length, accentColor: '#10b981' },
  ], [allTasks]);

  const recentIssues = useMemo(
    () => [...allIssues].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6),
    [allIssues],
  );

  const recentTasks = useMemo(
    () => [...allTasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6),
    [allTasks],
  );

  const projectName = project.data?.data?.name ?? slug;

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
      >
        <ProjectHeader name={projectName} showBack />

        <View className="px-4 mb-2">
          <SectionHeading>Issues</SectionHeading>
        </View>
        <StatsRow stats={issueStats} />

        <View className="px-4 mt-6 mb-2">
          <SectionHeading>Tasks</SectionHeading>
        </View>
        <StatsRow stats={taskStats} />

        <View className="px-4 mt-6 mb-2">
          <SectionHeading>Quick Actions</SectionHeading>
        </View>
        <View className="flex-row flex-wrap gap-3 px-4">
          {QUICK_ACTIONS.map((action) => (
            <Pressable
              key={action.key}
              className="flex-1 min-w-[45%]"
              onPress={() => router.push(`/(main)/projects/${slug}/${action.path}`)}
            >
              <Card>
                <Text className="text-center text-2xl mb-1">{action.icon}</Text>
                <Text className="text-center font-semibold text-sm">{action.label}</Text>
              </Card>
            </Pressable>
          ))}
        </View>

        <View className="px-4 mt-6 mb-2">
          <SectionHeading>Recent Issues</SectionHeading>
        </View>
        <View className="px-4 gap-2">
          {recentIssues.map((issue) => (
            <Pressable
              key={issue.documentId}
              onPress={() => router.push(`/(main)/projects/${slug}/issues/${issue.documentId}`)}
              className="flex-row items-center justify-between py-2 border-b border-gray-100"
            >
              <Text className="flex-1 mr-3 text-sm" numberOfLines={1}>{issue.title}</Text>
              <StatusBadge status={issue.status} />
            </Pressable>
          ))}
          {recentIssues.length === 0 && (
            <Text className="text-gray-400 text-center py-4">No issues yet</Text>
          )}
        </View>

        <View className="px-4 mt-6 mb-2">
          <SectionHeading>Recent Tasks</SectionHeading>
        </View>
        <View className="px-4 gap-2">
          {recentTasks.map((task) => (
            <Pressable
              key={task.documentId}
              onPress={() => router.push(`/(main)/projects/${slug}/tasks/${task.documentId}`)}
              className="flex-row items-center justify-between py-2 border-b border-gray-100"
            >
              <Text className="flex-1 mr-3 text-sm" numberOfLines={1}>{task.title}</Text>
              <TaskStatusBadge status={task.status} />
            </Pressable>
          ))}
          {recentTasks.length === 0 && (
            <Text className="text-gray-400 text-center py-4">No tasks yet</Text>
          )}
        </View>

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
