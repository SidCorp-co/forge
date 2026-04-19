import { View, Text, FlatList } from 'react-native';
import { fmt, fmtCost } from '@/lib/format';
import type { ModelUsage } from '@/features/usage/types';

interface ModelBreakdownProps {
  models: ModelUsage[];
}

export function ModelBreakdown({ models }: ModelBreakdownProps) {
  const maxCost = Math.max(...models.map((m) => m.cost), 1);

  return (
    <FlatList
      data={models}
      scrollEnabled={false}
      keyExtractor={(item) => item.model}
      renderItem={({ item }) => (
        <View className="px-3 py-2.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-gray-900">{item.model}</Text>
            <Text className="text-sm text-gray-700">{fmtCost(item.cost)}</Text>
          </View>
          <Text className="text-xs text-gray-500 mt-0.5">
            {fmt(item.input)} in + {fmt(item.output)} out
          </Text>
          <View className="h-2 bg-gray-100 rounded-full mt-1.5">
            <View
              className="h-2 bg-blue-500 rounded-full"
              style={{ width: `${(item.cost / maxCost) * 100}%` }}
            />
          </View>
        </View>
      )}
    />
  );
}
