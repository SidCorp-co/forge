import { useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useProject } from '@/features/project/hooks';
import { useSkills, useSkillSyncStatus, useBulkPushSkills } from '@/features/skill/hooks';
import { SkillCard } from '@/components/skill/skill-card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import type { Skill } from '@/features/skill/types';

export default function SkillsScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data: projectData } = useProject(slug);
  const projectDocId = projectData?.data?.documentId;

  const { data: skillsData, isLoading, isRefetching, refetch } = useSkills(projectDocId);
  const { data: syncData } = useSkillSyncStatus(projectDocId);
  const bulkPush = useBulkPushSkills();

  const skills = skillsData?.data ?? [];
  const syncStatuses = syncData?.data ?? [];

  const outOfSyncCount = useMemo(
    () => syncStatuses.filter((s) => s.devices.some((d) => !d.inSync)).length,
    [syncStatuses],
  );

  const [pushing, setPushing] = useState(false);

  const handleSyncAll = useCallback(async () => {
    if (!projectDocId) return;
    setPushing(true);
    try {
      await bulkPush.mutateAsync({ targets: ['dev', 'cloud'], projectDocumentId: projectDocId });
      Alert.alert('Sync complete', 'All skills have been pushed to devices.');
    } catch {
      Alert.alert('Sync failed', 'Failed to push skills to devices.');
    } finally {
      setPushing(false);
    }
  }, [projectDocId, bulkPush]);

  const handlePress = useCallback(
    (skill: Skill) => {
      router.push(`/(main)/projects/${slug}/skills/${skill.documentId}`);
    },
    [router, slug],
  );

  const renderItem = useCallback(
    ({ item }: { item: Skill }) => <SkillCard skill={item} onPress={handlePress} />,
    [handlePress],
  );

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      {/* Sync status banner */}
      {syncStatuses.length > 0 && (
        <View className={`px-4 py-2 flex-row items-center justify-between ${outOfSyncCount > 0 ? 'bg-amber-50' : 'bg-green-50'}`}>
          <Text className={`text-sm ${outOfSyncCount > 0 ? 'text-amber-700' : 'text-green-700'}`}>
            {outOfSyncCount > 0
              ? `${outOfSyncCount} skill${outOfSyncCount > 1 ? 's' : ''} out of sync`
              : 'All skills in sync'}
          </Text>
          {outOfSyncCount > 0 && (
            <Button
              title={pushing ? 'Syncing...' : 'Sync All'}
              variant="secondary"
              size="sm"
              onPress={handleSyncAll}
              disabled={pushing}
            />
          )}
        </View>
      )}

      <FlatList
        data={skills}
        keyExtractor={(item) => item.documentId}
        renderItem={renderItem}
        contentContainerClassName="px-4 pt-3 pb-20"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <View className="items-center mt-10">
            <Text className="text-gray-400 text-base">No skills configured</Text>
            <Text className="text-gray-400 text-sm mt-1">Add skills in the web dashboard</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}
