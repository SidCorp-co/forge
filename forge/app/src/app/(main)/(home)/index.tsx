import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useProjects } from '@/features/project/hooks';
import { useIssues } from '@/features/issue/hooks';
import { useTasks } from '@/features/task/hooks';
import { StatsRow } from '@/components/dashboard/stats-row';
import { ProjectList } from '@/components/dashboard/project-list';
import { RecentActivity } from '@/components/dashboard/recent-activity';
import { SectionHeading } from '@/components/ui/section-heading';
import type { Issue } from '@/features/issue/types';

export default function Dashboard() {
  const router = useRouter();
  const projects = useProjects();
  const issues = useIssues();
  const tasks = useTasks();
  const { refetch: refetchProjects } = projects;
  const { refetch: refetchIssues } = issues;
  const { refetch: refetchTasks } = tasks;

  const isRefreshing = projects.isRefetching || issues.isRefetching || tasks.isRefetching;

  const onRefresh = useCallback(() => {
    refetchProjects();
    refetchIssues();
    refetchTasks();
  }, [refetchProjects, refetchIssues, refetchTasks]);

  const stats = useMemo(() => {
    const allIssues = issues.data?.data ?? [];
    const allTasks = tasks.data?.data ?? [];
    return [
      { label: 'Projects', value: projects.data?.data?.length ?? 0, accentColor: '#3b82f6' },
      { label: 'Open Issues', value: allIssues.filter((i) => i.status === 'open').length, accentColor: '#f59e0b' },
      { label: 'Active Tasks', value: allTasks.filter((t) => t.status === 'in_progress').length, accentColor: '#8b5cf6' },
      { label: 'Resolved', value: allIssues.filter((i) => i.status === 'resolved').length, accentColor: '#10b981' },
    ];
  }, [projects.data, issues.data, tasks.data]);

  const sortedIssues = useMemo(() => {
    const all = issues.data?.data ?? [];
    return [...all].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [issues.data]);

  const handleProjectPress = (slug: string) => {
    router.push(`/(main)/projects/${slug}`);
  };

  const handleIssuePress = (issue: Issue) => {
    if (issue.project?.slug) {
      router.push(`/(main)/projects/${issue.project.slug}/issues/${issue.documentId}`);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
      >
        <Text className="text-2xl font-bold px-4 pt-4 pb-2">Dashboard</Text>

        <StatsRow stats={stats} />

        <View className="mt-6 mb-2 px-4">
          <SectionHeading>Projects</SectionHeading>
        </View>
        <ProjectList
          projects={projects.data?.data ?? []}
          onPress={handleProjectPress}
        />

        <View className="mt-6 mb-2 px-4">
          <SectionHeading>Recent Issues</SectionHeading>
        </View>
        <RecentActivity issues={sortedIssues} onPress={handleIssuePress} />

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
