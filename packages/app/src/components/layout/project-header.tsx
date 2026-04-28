import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';

interface ProjectHeaderProps {
  name: string;
  showBack?: boolean;
}

export function ProjectHeader({ name, showBack }: ProjectHeaderProps) {
  const router = useRouter();

  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      {showBack && (
        <Pressable onPress={() => router.back()}>
          <Text className="text-blue-600 text-base">‹ Back</Text>
        </Pressable>
      )}
      <Text className="text-lg font-bold flex-1">{name}</Text>
    </View>
  );
}
