import { useState } from 'react';
import { View, TextInput, Pressable, Text, ScrollView, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

interface ChatInputProps {
  onSend: (text: string, files?: { uri: string; name: string }[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, onStop, isStreaming, placeholder }: ChatInputProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ uri: string; name: string }[]>([]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed, files.length ? files : undefined);
    setText('');
    setFiles([]);
  };

  const handleAttach = () => {
    Alert.alert('Attach', 'Choose source', [
      {
        text: 'Camera',
        onPress: async () => {
          const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
          if (!res.canceled && res.assets[0]) {
            setFiles((f) => [...f, { uri: res.assets[0].uri, name: res.assets[0].fileName || 'photo.jpg' }]);
          }
        },
      },
      {
        text: 'Gallery',
        onPress: async () => {
          const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, allowsMultipleSelection: true });
          if (!res.canceled) {
            setFiles((f) => [...f, ...res.assets.map((a) => ({ uri: a.uri, name: a.fileName || 'image.jpg' }))]);
          }
        },
      },
      {
        text: 'File',
        onPress: async () => {
          const res = await DocumentPicker.getDocumentAsync({ multiple: true });
          if (!res.canceled) {
            setFiles((f) => [...f, ...res.assets.map((a) => ({ uri: a.uri, name: a.name }))]);
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const removeFile = (idx: number) => setFiles((f) => f.filter((_, i) => i !== idx));

  return (
    <View className="border-t border-gray-200 bg-white px-3 pb-2 pt-1">
      {files.length > 0 && (
        <ScrollView horizontal className="py-1" showsHorizontalScrollIndicator={false}>
          {files.map((f, i) => (
            <Pressable key={i} onPress={() => removeFile(i)} className="bg-gray-100 rounded-lg px-2 py-1 mr-2 flex-row items-center">
              <Text className="text-xs text-gray-600 max-w-[100px]" numberOfLines={1}>{f.name}</Text>
              <Text className="text-xs text-gray-400 ml-1">x</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View className="flex-row items-end gap-2">
        <Pressable onPress={handleAttach} className="w-9 h-9 items-center justify-center">
          <Text className="text-xl text-gray-500">+</Text>
        </Pressable>
        <TextInput
          className="flex-1 bg-gray-100 rounded-2xl px-4 py-2 text-base max-h-[100px]"
          placeholder={placeholder || 'Type a message...'}
          placeholderTextColor="#9ca3af"
          value={text}
          onChangeText={setText}
          multiline
          onSubmitEditing={handleSend}
        />
        {isStreaming ? (
          <Pressable onPress={onStop} className="w-9 h-9 items-center justify-center bg-red-500 rounded-full">
            <View className="w-3.5 h-3.5 bg-white rounded-sm" />
          </Pressable>
        ) : (
          <Pressable
            onPress={handleSend}
            disabled={!text.trim()}
            className={`w-9 h-9 items-center justify-center rounded-full ${text.trim() ? 'bg-gray-900' : 'bg-gray-300'}`}
          >
            <Text className="text-white text-lg">↑</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
