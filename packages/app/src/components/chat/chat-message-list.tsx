import { useRef, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { ChatMessage, type ChatMessageData } from './chat-message';

interface ChatMessageListProps {
  messages: ChatMessageData[];
  isStreaming?: boolean;
}

export function ChatMessageList({ messages, isStreaming }: ChatMessageListProps) {
  const listRef = useRef<FlatList>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottom = useRef(true);

  useEffect(() => {
    if (isNearBottom.current && messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages.length, messages[messages.length - 1]?.content]);

  return (
    <View className="flex-1">
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChatMessage message={item} />}
        contentContainerStyle={{ paddingVertical: 8 }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const near = contentOffset.y >= contentSize.height - layoutMeasurement.height - 100;
          isNearBottom.current = near;
          setShowScrollBtn(!near && messages.length > 3);
        }}
        scrollEventThrottle={100}
      />
      {showScrollBtn && (
        <Pressable
          className="absolute bottom-2 right-4 bg-gray-900 rounded-full w-8 h-8 items-center justify-center"
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
        >
          <Text className="text-white text-sm">↓</Text>
        </Pressable>
      )}
    </View>
  );
}
