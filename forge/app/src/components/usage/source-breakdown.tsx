import { View, Text, FlatList } from 'react-native';
import { fmtCost } from '@/lib/format';
import type { SourceUsage } from '@/features/usage/types';

interface SourceBreakdownProps {
  sources: SourceUsage[];
}

function capitalize(s: string): string {
  return s === 'cli' ? 'CLI' : s === 'api' ? 'API' : s.charAt(0).toUpperCase() + s.slice(1);
}

export function SourceBreakdown({ sources }: SourceBreakdownProps) {
  return (
    <FlatList
      data={sources}
      scrollEnabled={false}
      keyExtractor={(item) => item.source}
      renderItem={({ item }) => {
        const total = item.input + item.output;
        const inputPct = total > 0 ? (item.input / total) * 100 : 50;

        return (
          <View className="px-3 py-2.5">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold text-gray-900">{capitalize(item.source)}</Text>
              <Text className="text-sm text-gray-700">{fmtCost(item.cost)}</Text>
            </View>
            <View className="h-2.5 bg-gray-100 rounded-full mt-1.5 flex-row overflow-hidden">
              <View className="h-2.5 bg-blue-500" style={{ width: `${inputPct}%` }} />
              <View className="h-2.5 bg-purple-500" style={{ width: `${100 - inputPct}%` }} />
            </View>
          </View>
        );
      }}
    />
  );
}
