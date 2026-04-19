import { View } from 'react-native';
import { StatCard } from '@/components/ui/stat-card';
import { fmt, fmtCost } from '@/lib/format';
import type { UsageTotals } from '@/features/usage/types';

interface UsageMetricsProps {
  totals: UsageTotals;
}

export function UsageMetrics({ totals }: UsageMetricsProps) {
  const avgCost = totals.requests > 0 ? totals.estimatedCost / totals.requests : 0;

  const cards = [
    { label: 'Total Requests', value: fmt(totals.requests) },
    { label: 'Input Tokens', value: fmt(totals.inputTokens) },
    { label: 'Output Tokens', value: fmt(totals.outputTokens) },
    { label: 'Total Cost', value: fmtCost(totals.estimatedCost) },
    { label: 'Avg Cost/Request', value: fmtCost(avgCost) },
  ];

  return (
    <View className="flex-row flex-wrap gap-3">
      {cards.map((card, i) => (
        <View
          key={card.label}
          className={`w-[48%] ${i === cards.length - 1 && cards.length % 2 !== 0 ? 'self-center' : ''}`}
        >
          <StatCard label={card.label} value={card.value} />
        </View>
      ))}
    </View>
  );
}
