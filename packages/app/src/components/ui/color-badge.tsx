import { View, Text } from 'react-native';

interface ColorBadgeProps {
  label: string;
  bg: string;
  text: string;
}

export function ColorBadge({ label, bg, text }: ColorBadgeProps) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
