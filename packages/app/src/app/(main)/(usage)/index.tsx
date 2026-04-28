import { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useUsageSummary, useIngestCliUsage } from '@/features/usage/hooks';
import { UsageMetrics } from '@/components/usage/usage-metrics';
import { DailyBreakdown } from '@/components/usage/daily-breakdown';
import { ModelBreakdown } from '@/components/usage/model-breakdown';
import { SourceBreakdown } from '@/components/usage/source-breakdown';
import { FilterChip } from '@/components/ui/filter-chip';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/section-heading';
import { Spinner } from '@/components/ui/spinner';
import { AlertBanner } from '@/components/ui/alert-banner';

const ALL_SOURCES = ['cli', 'api', 'desktop'];
const DAY_OPTIONS = [7, 14, 30] as const;

export default function UsageScreen() {
  const [days, setDays] = useState<number>(7);
  const [activeSources, setActiveSources] = useState<string[]>(ALL_SOURCES);
  const { data, isLoading, isRefetching, error, refetch } = useUsageSummary(days);
  const ingestCliUsage = useIngestCliUsage();

  const onRefresh = useCallback(() => { refetch(); }, [refetch]);

  const toggleSource = useCallback((source: string) => {
    setActiveSources((prev) => {
      if (source === 'all') return prev.length === ALL_SOURCES.length ? [] : [...ALL_SOURCES];
      const next = prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source];
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (!data) return null;
    const bySource = data.bySource.filter((s) => activeSources.includes(s.source));
    return { ...data, bySource };
  }, [data, activeSources]);

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-white items-center justify-center">
        <Spinner size="large" />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-white p-4">
        <AlertBanner type="error" message={error.message ?? 'Failed to load usage data'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <ScrollView
        className="flex-1 px-4"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
      >
        <Text className="text-2xl font-bold mt-2 mb-4">Usage</Text>

        <View className="flex-row flex-wrap gap-2 mb-3">
          <FilterChip label="All" active={activeSources.length === ALL_SOURCES.length} onPress={() => toggleSource('all')} />
          {ALL_SOURCES.map((s) => (
            <FilterChip key={s} label={s === 'cli' ? 'CLI' : s === 'api' ? 'API' : 'Desktop'} active={activeSources.includes(s)} onPress={() => toggleSource(s)} />
          ))}
        </View>

        <View className="flex-row gap-2 mb-3">
          {DAY_OPTIONS.map((d) => (
            <FilterChip key={d} label={`${d}d`} active={days === d} onPress={() => setDays(d)} />
          ))}
        </View>

        <Button
          variant="secondary"
          size="sm"
          title="Sync CLI"
          onPress={() => ingestCliUsage.mutate()}
          disabled={ingestCliUsage.isPending}
          className="self-start mb-4"
        />

        {filtered && (
          <>
            <UsageMetrics totals={filtered.totals} />

            <View className="mt-5">
              <SectionHeading>Daily Breakdown</SectionHeading>
              <DailyBreakdown daily={filtered.daily} />
            </View>

            <View className="mt-5">
              <SectionHeading>By Model</SectionHeading>
              <ModelBreakdown models={filtered.byModel} />
            </View>

            <View className="mt-5 mb-8">
              <SectionHeading>By Source</SectionHeading>
              <SourceBreakdown sources={filtered.bySource} />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
