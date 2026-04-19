import { View, Text } from 'react-native';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
}

export function EmptyState({ icon = '📭', title, description }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center py-12 px-4">
      <Text className="text-3xl mb-3">{icon}</Text>
      <Text className="font-semibold text-gray-500 text-center">{title}</Text>
      {description && (
        <Text className="text-sm text-gray-400 text-center mt-1">{description}</Text>
      )}
    </View>
  );
}
