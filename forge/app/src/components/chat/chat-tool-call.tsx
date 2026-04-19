import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Spinner } from '@/components/ui/spinner';
import type { ToolCallData } from './chat-message';

export function ChatToolCall({ name, input, result, isStreaming, isError }: ToolCallData) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable onPress={() => setExpanded(!expanded)}>
      <View
        className={`border rounded-lg my-1 overflow-hidden ${isError ? 'border-red-300' : 'border-gray-200'}`}
      >
        <View className="flex-row items-center justify-between px-3 py-2 bg-gray-50">
          <Text className="text-sm font-mono text-gray-700" numberOfLines={1}>
            {name}
          </Text>
          {isStreaming ? (
            <Spinner size="small" />
          ) : (
            <Text className="text-sm">{expanded ? '▲' : '▼'}</Text>
          )}
        </View>
        {expanded && (
          <View className="px-3 py-2 border-t border-gray-200">
            {input != null && (
              <>
                <Text className="text-xs font-semibold text-gray-500 mb-1">Input:</Text>
                <Text className="text-xs font-mono text-gray-600" selectable>
                  {JSON.stringify(input, null, 2)}
                </Text>
              </>
            )}
            {result != null && (
              <>
                <Text className="text-xs font-semibold text-gray-500 mt-2 mb-1">Result:</Text>
                <Text
                  className={`text-xs font-mono ${isError ? 'text-red-600' : 'text-gray-600'}`}
                  selectable
                >
                  {result}
                </Text>
              </>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}
