import { useState } from 'react';
import { View, Text, ScrollView, Image, Pressable, Modal } from 'react-native';
import { API_URL } from '@/lib/constants';

interface Attachment {
  url: string;
  name: string;
}

interface AttachmentViewerProps {
  attachments: Attachment[];
  onUpload?: () => void;
}

function resolveUrl(url: string) {
  if (url.startsWith('http')) return url;
  const base = API_URL.replace(/\/api$/, '');
  return `${base}${url}`;
}

export function AttachmentViewer({ attachments, onUpload }: AttachmentViewerProps) {
  const [selected, setSelected] = useState<string | null>(null);

  if (attachments.length === 0 && !onUpload) return null;

  return (
    <View className="mt-3">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="gap-2">
        <View className="flex-row gap-2">
          {attachments.map((a, i) => (
            <Pressable key={i} onPress={() => setSelected(resolveUrl(a.url))}>
              <Image
                source={{ uri: resolveUrl(a.url) }}
                className="w-20 h-20 rounded-lg bg-gray-100"
              />
            </Pressable>
          ))}
          {onUpload && (
            <Pressable
              className="w-20 h-20 rounded-lg bg-gray-100 items-center justify-center"
              onPress={onUpload}
            >
              <Text className="text-2xl text-gray-400">+</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      <Modal visible={!!selected} transparent animationType="fade">
        <Pressable
          className="flex-1 bg-black/80 items-center justify-center"
          onPress={() => setSelected(null)}
        >
          {selected && (
            <Image
              source={{ uri: selected }}
              className="w-full h-3/4"
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}
