import { useState } from 'react';
import { View, Text, ScrollView, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useIssue, useUpdateIssue, useEnrichIssue } from '@/features/issue/hooks';
import { useComments, useCreateComment } from '@/features/comment/hooks';
import { StatusBadge } from '@/components/ui/status-badge';
import { PriorityBadge } from '@/components/ui/priority-badge';
import { StatusPicker } from '@/components/issue/status-picker';
import { PriorityPicker } from '@/components/issue/priority-picker';
import { AttachmentViewer } from '@/components/issue/attachment-viewer';
import { AIAnalysisSection } from '@/components/issue/ai-analysis-section';
import { TaskProgressSection } from '@/components/issue/task-progress-section';
import { CommentSection } from '@/components/issue/comment-section';
import type { IssueStatus, IssuePriority } from '@/features/issue/types';

export default function IssueDetailScreen() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const { data: issueData, isLoading } = useIssue(id);
  const { data: commentsData } = useComments(id);
  const updateIssue = useUpdateIssue();
  const enrichIssue = useEnrichIssue();
  const createComment = useCreateComment(id);

  const [statusPicker, setStatusPicker] = useState(false);
  const [priorityPicker, setPriorityPicker] = useState(false);

  const issue = issueData?.data;
  const comments = commentsData?.data ?? [];

  if (isLoading || !issue) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const canEnrich = issue.status === 'open' || issue.status === 'confirmed';

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView className="flex-1 px-4 pt-3" contentContainerClassName="pb-10">
          <Text className="text-xl font-bold text-gray-900">{issue.title}</Text>
          {issue.reportedBy && (
            <Text className="text-xs text-gray-500 mt-1">Reported by {issue.reportedBy}</Text>
          )}

          <View className="flex-row items-center gap-2 mt-3 flex-wrap">
            <Pressable onPress={() => setStatusPicker(true)}>
              <StatusBadge status={issue.status} />
            </Pressable>
            <Pressable onPress={() => setPriorityPicker(true)}>
              <PriorityBadge priority={issue.priority} />
            </Pressable>
            {canEnrich && (
              <Pressable
                className="bg-blue-50 rounded-full px-3 py-1"
                onPress={() => enrichIssue.mutate(issue.documentId)}
                disabled={enrichIssue.isPending}
              >
                <Text className="text-xs font-semibold text-blue-700">
                  {enrichIssue.isPending ? 'Enriching...' : 'Enrich'}
                </Text>
              </Pressable>
            )}
          </View>

          {issue.description ? (
            <Text className="text-sm text-gray-700 mt-4">{issue.description}</Text>
          ) : null}

          <AttachmentViewer attachments={issue.attachments} />
          <AIAnalysisSection issue={issue} />
          <TaskProgressSection tasks={issue.tasks} />

          {/* Change History */}
          {issue.changeHistory && issue.changeHistory.length > 0 && (
            <View className="mt-4">
              <Text className="text-sm font-semibold text-gray-900 mb-2">History</Text>
              {issue.changeHistory.map((entry, i) => (
                <View key={i} className="flex-row flex-wrap items-baseline gap-1 mb-1">
                  <Text className="text-[10px] text-gray-400">{new Date(entry.at).toLocaleDateString()}</Text>
                  <Text className="text-xs text-gray-500">
                    <Text className="font-medium text-gray-600">{entry.by}</Text>
                    {' changed '}
                    <Text className="font-medium">{entry.field}</Text>
                    {' from '}
                    <Text className="bg-gray-100 px-1">{entry.from ?? 'none'}</Text>
                    {' to '}
                    <Text className="bg-gray-100 px-1">{entry.to}</Text>
                  </Text>
                </View>
              ))}
            </View>
          )}

          <CommentSection
            comments={comments}
            onAddComment={(body) => createComment.mutate({ body, issue: id })}
            isAdding={createComment.isPending}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <StatusPicker
        visible={statusPicker}
        currentStatus={issue.status}
        onSelect={(s) => updateIssue.mutate({ id: issue.documentId, data: { status: s } })}
        onClose={() => setStatusPicker(false)}
      />
      <PriorityPicker
        visible={priorityPicker}
        currentPriority={issue.priority}
        onSelect={(p) => updateIssue.mutate({ id: issue.documentId, data: { priority: p } })}
        onClose={() => setPriorityPicker(false)}
      />
    </SafeAreaView>
  );
}
