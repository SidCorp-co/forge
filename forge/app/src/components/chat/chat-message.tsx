import { useState } from 'react';
import { View, Text, Image, Pressable, Modal } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { ChatToolCall } from './chat-tool-call';
import { mediaUrl } from '@/lib/api-client';

export interface ToolCallData {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  isStreaming?: boolean;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  attachments?: { id?: number; url: string; name: string }[];
  toolCalls?: ToolCallData[];
  isStreaming?: boolean;
}

function TypingDots() {
  return (
    <View className="flex-row gap-1 py-1">
      <View className="w-2 h-2 rounded-full bg-gray-400" />
      <View className="w-2 h-2 rounded-full bg-gray-300" />
      <View className="w-2 h-2 rounded-full bg-gray-200" />
    </View>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatMessage({ message }: { message: ChatMessageData }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  if (message.role === 'system') {
    return (
      <View className="items-center my-2">
        <View className="bg-gray-100 rounded-full px-3 py-1">
          <Text className="text-xs text-gray-500">{message.content}</Text>
        </View>
      </View>
    );
  }

  if (message.role === 'user') {
    return (
      <View className="items-end my-1 px-4">
        {message.attachments && message.attachments.length > 0 && (
          <View className="flex-row flex-wrap gap-2 mb-1 justify-end">
            {message.attachments.map((a, i) => (
              <Pressable key={i} onPress={() => setPreviewUrl(mediaUrl(a.url))}>
                <Image
                  source={{ uri: mediaUrl(a.url) }}
                  className="h-20 w-20 rounded-lg"
                  resizeMode="cover"
                />
              </Pressable>
            ))}
          </View>
        )}
        <View className="bg-gray-900 rounded-2xl px-4 py-2.5 max-w-[85%]">
          <Text className="text-white text-base">{message.content}</Text>
        </View>
        <Text className="text-xs text-gray-400 mt-1">{formatTime(message.timestamp)}</Text>

        <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
          <Pressable className="flex-1 bg-black/90 items-center justify-center" onPress={() => setPreviewUrl(null)}>
            <Pressable className="absolute top-12 right-4 z-10 p-2">
              <Text className="text-white text-2xl">✕</Text>
            </Pressable>
            {previewUrl && (
              <Image
                source={{ uri: previewUrl }}
                className="w-[90%] h-[80%]"
                resizeMode="contain"
              />
            )}
          </Pressable>
        </Modal>
      </View>
    );
  }

  // assistant
  const showTyping = message.isStreaming && !message.content && !message.toolCalls?.length;

  return (
    <View className="items-start my-1 px-4">
      <View className="flex-row items-start gap-2 max-w-[90%]">
        <View className="w-6 h-6 rounded-full bg-blue-500 items-center justify-center mt-1">
          <Text className="text-white text-xs font-bold">AI</Text>
        </View>
        <View className="flex-1">
          {showTyping ? (
            <TypingDots />
          ) : (
            <>
              {message.content ? (
                <Markdown style={{ body: { fontSize: 15, color: '#111' } }}>
                  {message.content}
                </Markdown>
              ) : null}
              {message.toolCalls?.map((tc) => (
                <ChatToolCall key={tc.id} {...tc} />
              ))}
            </>
          )}
        </View>
      </View>
      <Text className="text-xs text-gray-400 mt-1 ml-8">{formatTime(message.timestamp)}</Text>
    </View>
  );
}
