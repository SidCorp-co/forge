import { Text } from 'react-native';

export function SectionHeading({ children }: { children: string }) {
  return <Text className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{children}</Text>;
}
