import { View, Text } from 'react-native';
import { Card } from './card';

interface StatCardProps {
  label: string;
  value: string | number;
  subLabel?: string;
  accentColor?: string;
}

export function StatCard({ label, value, subLabel, accentColor }: StatCardProps) {
  return (
    <Card>
      <View
        style={accentColor ? { borderLeftWidth: 3, borderLeftColor: accentColor, paddingLeft: 12 } : undefined}
      >
        <Text className="text-xs text-gray-500">{label}</Text>
        <Text className="text-2xl font-bold">{value}</Text>
        {subLabel && <Text className="text-xs text-gray-400">{subLabel}</Text>}
      </View>
    </Card>
  );
}
