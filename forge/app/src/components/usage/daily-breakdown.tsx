import { View, Text, FlatList } from 'react-native';
import { fmt, fmtCost } from '@/lib/format';
import type { DailyUsage } from '@/features/usage/types';

interface DailyBreakdownProps {
  daily: DailyUsage[];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' });
}

export function DailyBreakdown({ daily }: DailyBreakdownProps) {
  return (
    <FlatList
      data={daily}
      scrollEnabled={false}
      keyExtractor={(item) => item.date}
      renderItem={({ item, index }) => (
        <View className={`px-3 py-2.5 rounded-lg ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
          <Text className="text-sm font-semibold text-gray-900">{formatDate(item.date)}</Text>
          <View className="flex-row gap-3 mt-1">
            <Text className="text-xs text-gray-500">In: {fmt(item.input)}</Text>
            <Text className="text-xs text-gray-500">Out: {fmt(item.output)}</Text>
            <Text className="text-xs text-gray-500">Req: {item.requests}</Text>
            <Text className="text-xs text-gray-500">Cost: {fmtCost(item.cost)}</Text>
          </View>
        </View>
      )}
    />
  );
}
