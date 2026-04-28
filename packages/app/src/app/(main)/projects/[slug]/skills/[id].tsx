import { useState, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useSkill, useUpdateSkill } from '@/features/skill/hooks';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';

const TARGET_LABELS: Record<string, string> = {
  dev: 'Dev',
  cloud: 'Cloud',
  all: 'All',
};

export default function SkillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useSkill(id);
  const updateMutation = useUpdateSkill();

  const skill = data?.data;

  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  const handleEdit = useCallback(() => {
    if (!skill) return;
    setEditContent(skill.skillMd ?? '');
    setEditing(true);
  }, [skill]);

  const handleSave = useCallback(async () => {
    if (!skill) return;
    try {
      await updateMutation.mutateAsync({
        documentId: skill.documentId,
        data: { skillMd: editContent },
      });
      setEditing(false);
      Alert.alert('Saved', 'Skill content updated.');
    } catch {
      Alert.alert('Error', 'Failed to save skill.');
    }
  }, [skill, editContent, updateMutation]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setEditContent('');
  }, []);

  if (isLoading || !skill) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Header */}
        <Text className="text-xl font-bold text-gray-900 mb-1">{skill.name}</Text>
        {skill.description ? (
          <Text className="text-sm text-gray-500 mb-3">{skill.description}</Text>
        ) : null}

        {/* Meta */}
        <View className="flex-row flex-wrap gap-3 mb-4">
          <View className="bg-gray-100 px-2.5 py-1 rounded">
            <Text className="text-xs text-gray-600">v{skill.version}</Text>
          </View>
          <View className="bg-gray-100 px-2.5 py-1 rounded">
            <Text className="text-xs text-gray-600">{TARGET_LABELS[skill.target] ?? skill.target}</Text>
          </View>
          {skill.isGlobal && (
            <View className="bg-amber-50 px-2.5 py-1 rounded">
              <Text className="text-xs text-amber-600">Global</Text>
            </View>
          )}
          {skill.contentHash && (
            <View className="bg-gray-100 px-2.5 py-1 rounded">
              <Text className="text-xs text-gray-500">Hash: {skill.contentHash.slice(0, 12)}</Text>
            </View>
          )}
        </View>

        {/* Content */}
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Content</Text>
            {!editing && (
              <Button title="Edit" variant="secondary" size="sm" onPress={handleEdit} />
            )}
          </View>
          {editing ? (
            <View>
              <TextInput
                value={editContent}
                onChangeText={setEditContent}
                multiline
                className="border border-gray-300 rounded-lg p-3 text-sm text-gray-800 font-mono min-h-[200px]"
                textAlignVertical="top"
              />
              <View className="flex-row gap-2 mt-3">
                <Button
                  title={updateMutation.isPending ? 'Saving...' : 'Save'}
                  variant="primary"
                  size="sm"
                  onPress={handleSave}
                  disabled={updateMutation.isPending}
                />
                <Button title="Cancel" variant="secondary" size="sm" onPress={handleCancel} />
              </View>
            </View>
          ) : (
            <View className="bg-gray-50 rounded-lg p-3">
              <Text className="text-sm text-gray-700 font-mono">
                {skill.skillMd || 'No content'}
              </Text>
            </View>
          )}
        </View>

        {/* Files */}
        {skill.files && skill.files.length > 0 && (
          <View className="mb-4">
            <Text className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Files ({skill.files.length})
            </Text>
            {skill.files.map((file, i) => (
              <View key={i} className="bg-gray-50 rounded-lg px-3 py-2 mb-1">
                <Text className="text-sm text-gray-600 font-mono">{file.path}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Version History */}
        {skill.changelog && skill.changelog.length > 0 && (
          <View>
            <Text className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Version History
            </Text>
            {skill.changelog.map((entry, i) => (
              <View key={i} className="border-l-2 border-gray-200 pl-3 pb-3 mb-1">
                <View className="flex-row items-center gap-2 mb-0.5">
                  <Text className="text-sm font-medium text-gray-900">v{entry.version}</Text>
                  <Text className="text-xs text-gray-400">
                    {new Date(entry.timestamp).toLocaleDateString()}
                  </Text>
                </View>
                <Text className="text-sm text-gray-600">{entry.summary}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
