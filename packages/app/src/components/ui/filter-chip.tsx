import { Pressable, Text } from 'react-native';

interface FilterChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

export function FilterChip({ label, active, onPress }: FilterChipProps) {
  return (
    <Pressable
      className={`rounded-full px-3 py-1.5 ${active ? 'bg-gray-900' : 'bg-gray-100'}`}
      onPress={onPress}
    >
      <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-gray-600'}`}>
        {label}
      </Text>
    </Pressable>
  );
}
