import { View } from 'react-native';
import { StatCard } from '@/components/ui/stat-card';

interface Stat {
  label: string;
  value: string | number;
  subLabel?: string;
  accentColor?: string;
}

export function StatsRow({ stats }: { stats: Stat[] }) {
  return (
    <View className="flex-row flex-wrap gap-3 px-4">
      {stats.map((s, i) => (
        <View key={i} className="flex-1 min-w-[45%]">
          <StatCard {...s} />
        </View>
      ))}
    </View>
  );
}
