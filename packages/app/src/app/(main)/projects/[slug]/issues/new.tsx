import { useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, Image, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useProject } from '@/features/project/hooks';
import { useCreateIssue } from '@/features/issue/hooks';
import { issueApi } from '@/features/issue/api';
import { FilterChip } from '@/components/ui/filter-chip';
import { Button } from '@/components/ui/button';
import { ALL_PRIORITIES } from '@/lib/colors';
import type { IssuePriority } from '@/features/issue/types';

interface LocalAttachment {
  uri: string;
  name: string;
  type: string;
}

export default function NewIssueScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data: projectData } = useProject(slug);
  const createIssue = useCreateIssue();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const project = projectData?.data;

  const pickCamera = async () => {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      setAttachments((prev) => [...prev, { uri: a.uri, name: a.fileName ?? 'photo.jpg', type: a.mimeType ?? 'image/jpeg' }]);
    }
  };

  const pickGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, allowsMultipleSelection: true });
    if (!result.canceled) {
      const newFiles = result.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName ?? 'image.jpg',
        type: a.mimeType ?? 'image/jpeg',
      }));
      setAttachments((prev) => [...prev, ...newFiles]);
    }
  };

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (!result.canceled) {
      const newFiles = result.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        type: a.mimeType ?? 'application/octet-stream',
      }));
      setAttachments((prev) => [...prev, ...newFiles]);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!project) return;
    setSubmitting(true);
    setError('');

    try {
      const uploadedIds: number[] = [];
      for (const file of attachments) {
        const uploaded = await issueApi.uploadFile(file);
        if (uploaded) uploadedIds.push(uploaded.id);
      }

      await createIssue.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        priority,
        project: project.documentId,
        attachments: uploadedIds.length > 0 ? uploadedIds : undefined,
      });
      router.back();
    } catch (e: any) {
      setError(e.message ?? 'Failed to create issue');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView className="flex-1 px-4 pt-3" contentContainerClassName="pb-10">
          <Text className="text-lg font-bold text-gray-900 mb-4">New Issue</Text>

          {error ? <Text className="text-red-600 text-sm mb-2">{error}</Text> : null}

          <Text className="text-sm font-medium text-gray-700 mb-1">Title</Text>
          <TextInput
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
            placeholder="Issue title"
            value={title}
            onChangeText={setTitle}
          />

          <Text className="text-sm font-medium text-gray-700 mb-1">Description</Text>
          <TextInput
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 h-32"
            placeholder="Describe the issue..."
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
          />

          <Text className="text-sm font-medium text-gray-700 mb-2">Priority</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            <View className="flex-row gap-1.5">
              {ALL_PRIORITIES.map((p) => (
                <FilterChip
                  key={p.value}
                  label={p.label}
                  active={priority === p.value}
                  onPress={() => setPriority(p.value)}
                />
              ))}
            </View>
          </ScrollView>

          <Text className="text-sm font-medium text-gray-700 mb-2">Attachments</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            <View className="flex-row gap-2">
              {attachments.map((a, i) => (
                <Image key={i} source={{ uri: a.uri }} className="w-20 h-20 rounded-lg bg-gray-100" />
              ))}
              <Pressable className="w-20 h-20 rounded-lg bg-gray-100 items-center justify-center" onPress={pickCamera}>
                <Text className="text-xl text-gray-400">cam</Text>
              </Pressable>
              <Pressable className="w-20 h-20 rounded-lg bg-gray-100 items-center justify-center" onPress={pickGallery}>
                <Text className="text-xl text-gray-400">img</Text>
              </Pressable>
              <Pressable className="w-20 h-20 rounded-lg bg-gray-100 items-center justify-center" onPress={pickFile}>
                <Text className="text-xl text-gray-400">file</Text>
              </Pressable>
            </View>
          </ScrollView>

          <View className="gap-2">
            <Button title={submitting ? 'Creating...' : 'Create Issue'} onPress={handleSubmit} disabled={submitting} />
            <Button title="Cancel" variant="secondary" onPress={() => router.back()} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
