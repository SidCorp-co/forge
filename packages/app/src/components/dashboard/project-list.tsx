import { FlatList, Pressable, Text, View } from 'react-native';
import { Card } from '@/components/ui/card';
import type { Project } from '@/features/project/types';

interface ProjectListProps {
  projects: Project[];
  onPress: (slug: string) => void;
}

export function ProjectList({ projects, onPress }: ProjectListProps) {
  return (
    <FlatList
      data={projects}
      keyExtractor={(item) => item.documentId}
      scrollEnabled={false}
      contentContainerClassName="px-4 gap-3"
      renderItem={({ item }) => (
        <Pressable onPress={() => onPress(item.slug)}>
          <Card>
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-3">
                <Text className="font-bold text-base">{item.name}</Text>
                {item.description ? (
                  <Text className="text-gray-500 text-sm mt-1" numberOfLines={1}>
                    {item.description}
                  </Text>
                ) : null}
              </View>
              <Text className="text-gray-400 text-lg">›</Text>
            </View>
          </Card>
        </Pressable>
      )}
      ListEmptyComponent={
        <Text className="text-gray-400 text-center py-4">No projects yet</Text>
      }
    />
  );
}
