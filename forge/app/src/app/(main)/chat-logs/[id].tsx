import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useChatLog } from '@/features/chat-log/hooks';
import { Spinner } from '@/components/ui/spinner';
import { AlertBanner } from '@/components/ui/alert-banner';

function formatDuration(ms: number | null) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(usage: { input_tokens?: number; output_tokens?: number } | null) {
  if (!usage) return '—';
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  return `${inp.toLocaleString()} in / ${out.toLocaleString()} out`;
}

export default function ChatLogDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: log, isLoading, error } = useChatLog(id);

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <Stack.Screen options={{ headerShown: true, title: 'Chat Log' }} />
        <Spinner size="large" />
      </SafeAreaView>
    );
  }

  if (error || !log) {
    return (
      <SafeAreaView className="flex-1 bg-white p-4">
        <Stack.Screen options={{ headerShown: true, title: 'Chat Log' }} />
        <AlertBanner type="error" message={error?.message ?? 'Chat log not found'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Stack.Screen options={{ headerShown: true, title: log.projectSlug }} />
      <ScrollView className="flex-1 px-4">
        {/* Metadata */}
        <View className="bg-gray-50 rounded-xl p-3 mt-2 mb-4">
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            {log.model && (
              <Text className="text-xs text-gray-500">Model: <Text className="font-medium text-gray-700">{log.model}</Text></Text>
            )}
            <Text className="text-xs text-gray-500">Duration: <Text className="font-medium text-gray-700">{formatDuration(log.durationMs)}</Text></Text>
            <Text className="text-xs text-gray-500">Tokens: <Text className="font-medium text-gray-700">{formatTokens(log.usage)}</Text></Text>
            <Text className="text-xs text-gray-500">Source: <Text className="font-medium text-gray-700">{log.source}</Text></Text>
            {log.qaRating && (
              <Text className="text-xs text-gray-500">Rating: <Text className="font-medium text-gray-700">{log.qaRating}</Text></Text>
            )}
          </View>
        </View>

        {/* Error banner */}
        {log.error && (
          <View className="mb-4">
            <AlertBanner type="error" message={log.error} />
          </View>
        )}

        {/* User query bubble */}
        <View className="items-end mb-3">
          <View className="bg-gray-900 rounded-2xl rounded-br-sm px-4 py-3 max-w-[85%]">
            <Text className="text-sm text-white">{log.query}</Text>
          </View>
        </View>

        {/* Assistant reply bubble */}
        {log.reply && (
          <View className="items-start mb-6">
            <View className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 max-w-[85%]">
              <Text className="text-sm text-gray-900">{log.reply}</Text>
            </View>
          </View>
        )}

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
