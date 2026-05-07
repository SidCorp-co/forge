'use client';

import { Skeleton } from '@/components/ui';
import { useIssueCost } from '@/features/issue/hooks/use-issue-cost';
import { formatApiError } from '@/lib/api/error';

interface IssueCostSummaryProps {
  issueId: string;
}

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
});

const numFmt = new Intl.NumberFormat('en-US');

export function IssueCostSummary({ issueId }: IssueCostSummaryProps) {
  const { data, isLoading, error } = useIssueCost(issueId);

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Chi phí
        </h3>
      </div>
      <div className="p-4 text-sm">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(error)}
          </p>
        ) : !data || data.sampleCount === 0 ? (
          <p className="text-[11px] text-outline">Chưa có dữ liệu chi phí.</p>
        ) : (
          <CostRows data={data} />
        )}
      </div>
    </section>
  );
}

interface CostData {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

function CostRows({ data }: { data: CostData }) {
  const totalTokens =
    data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens;
  const tooltip = [
    `input: ${numFmt.format(data.inputTokens)}`,
    `output: ${numFmt.format(data.outputTokens)}`,
    `cache read: ${numFmt.format(data.cacheReadTokens)}`,
    `cache create: ${numFmt.format(data.cacheCreationTokens)}`,
  ].join('\n');

  return (
    <dl className="space-y-1.5 text-xs">
      <Row label="Estimated">
        <span className="font-mono text-on-surface">{moneyFmt.format(data.estimatedCost)}</span>
      </Row>
      <Row label="Tokens">
        <span className="font-mono text-on-surface" title={tooltip}>
          {numFmt.format(totalTokens)}
        </span>
      </Row>
      <Row label="Requests">
        <span className="font-mono text-on-surface">{numFmt.format(data.requests)}</span>
      </Row>
      <Row label="Sessions">
        <span className="font-mono text-on-surface">{numFmt.format(data.sampleCount)}</span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[10px] font-bold uppercase tracking-widest text-outline">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default IssueCostSummary;
