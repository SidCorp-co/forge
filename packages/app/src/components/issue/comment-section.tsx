import { useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList } from 'react-native';
import { Card } from '@/components/ui/card';
import { relativeTime } from '@/lib/format';
import type { Comment } from '@/features/comment/types';

interface CommentSectionProps {
  comments: Comment[];
  onAddComment: (body: string) => void;
  isAdding: boolean;
}

export function CommentSection({ comments, onAddComment, isAdding }: CommentSectionProps) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const body = text.trim();
    if (!body) return;
    onAddComment(body);
    setText('');
  };

  return (
    <View className="mt-4">
      <Text className="text-base font-semibold text-gray-900 mb-2">Comments</Text>
      <FlatList
        data={comments}
        scrollEnabled={false}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <Card className={`mb-2 ${item.isAI ? 'border-l-4 border-l-purple-500' : ''}`}>
            <Text className={`text-sm font-bold ${item.isAI ? 'text-purple-600 italic' : 'text-gray-900'}`}>
              {item.isAI ? 'AI' : item.author}
            </Text>
            <Text className="text-sm text-gray-700 mt-1">{item.body}</Text>
            <Text className="text-xs text-gray-400 mt-1">{relativeTime(item.createdAt)}</Text>
          </Card>
        )}
        ListEmptyComponent={
          <Text className="text-sm text-gray-400 text-center py-4">No comments yet</Text>
        }
      />
      <View className="flex-row items-center gap-2 mt-2">
        <TextInput
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          placeholder="Add a comment..."
          value={text}
          onChangeText={setText}
          editable={!isAdding}
        />
        <Pressable
          className={`bg-gray-900 rounded-lg px-4 py-2 ${isAdding ? 'opacity-50' : ''}`}
          onPress={handleSend}
          disabled={isAdding}
        >
          <Text className="text-white text-sm font-semibold">Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
