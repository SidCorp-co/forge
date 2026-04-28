'use client';

import { useState, useMemo, useId } from 'react';
import { useUsageSummary } from '../../hooks/use-usage';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { SourceChips } from './source-chips';
import { DailyChart } from './daily-chart';
import { CumulativeCost } from './cumulative-cost';
import { ModelBreakdown } from './model-breakdown';
import { SourceBreakdown } from './source-breakdown';
import { fmt, fmtCost, localDate, DAY_OPTIONS } from './helpers';

function DayChips({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-surface-container-high p-0.5">
      {DAY_OPTIONS.map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={`rounded-md px-2.5 py-2 text-xs font-medium transition-all ${
            value === d ? 'bg-surface-container-low text-on-surface shadow-sm' : 'text-primary-fixed hover:text-on-surface-variant'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

export function UsageDashboard({ projectId }: { projectId?: string }) {
  const gradientId = useId();
  const [days, setDays] = useState(7);
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
  const { data: summary, isLoading, isError } = useUsageSummary(projectId, days);

  const toggleSource = (s: string) => {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const daily = summary?.daily ?? [];
  const maxTokens = daily.reduce((m, d) => Math.max(m, d.input + d.output), 1);
  const maxCost = daily.reduce((m, d) => Math.max(m, d.cost), 0);
  const today = localDate();
  const todayData = daily.find((d) => d.date === today);

  const filteredSources = useMemo(() => {
    if (!summary) return [];
    if (activeSources.size === 0) return summary.bySource;
    return summary.bySource.filter((s) => activeSources.has(s.source));
  }, [summary, activeSources]);

  const models = summary?.byModel ?? [];

  if (isLoading) {
    return (
      <section className="mt-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (isError || !summary) {
    return (
      <section className="mt-8 rounded-lg border bg-surface-container-low p-8 text-center">
        <p className="text-sm text-primary-fixed">Failed to load usage data.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 space-y-4 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-lg font-semibold text-on-surface">Usage</h2>
          <SourceChips sources={summary.bySource} active={activeSources} onToggle={toggleSource} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Sync-CLI requires CLI-collected records from the desktop app — the
            web dashboard has no source of those records, and the backend
            `bulkSchema` rejects empty `records: []` with 400. The button is
            hidden until packages/dev wires the real ingest path.
          */}
          <DayChips value={days} onChange={setDays} />
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Tokens Today"
          value={fmt((todayData?.input ?? 0) + (todayData?.output ?? 0))}
          sub={`${fmt(todayData?.input ?? 0)} in / ${fmt(todayData?.output ?? 0)} out`}
        />
        <StatCard label="Cost Today" value={fmtCost(todayData?.cost ?? 0)} accent="text-warning" />
        <StatCard label="Requests" value={fmt(summary.totals.requests)} sub={`${days}d total`} />
        <StatCard label="Total Cost" value={fmtCost(summary.totals.estimatedCost)} sub={`${days}d total`} accent="text-warning" />
        <StatCard
          label="Top Model"
          value={(models[0]?.model ?? '—').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 14)}
          sub={models[0] ? fmtCost(models[0].cost) : undefined}
        />
      </div>

      {/* Cumulative */}
      <CumulativeCost daily={daily} gradientId={`cumGrad${gradientId}`} />

      {/* Chart */}
      <DailyChart daily={daily} maxTokens={maxTokens} maxCost={maxCost} />

      {/* Bottom grid */}
      <div className="grid gap-4 md:grid-cols-2">
        <ModelBreakdown models={models} />
        <SourceBreakdown sources={filteredSources} />
      </div>
    </section>
  );
}
