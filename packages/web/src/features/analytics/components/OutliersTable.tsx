'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Outliers, OutlierRun } from '../types';
import { formatUsd } from './format';
import { Panel, ErrorPill, LoadingLine } from './panel';

interface Props {
  query: UseQueryResult<Outliers>;
  projectSlug: string;
}

const ROW_CAP = 50;
const PATTERN_THRESHOLD = 3;

type DescBucket = 'short' | 'medium' | 'long';
type DepthBucket = 'shallow' | 'medium' | 'deep';

function descBucket(len: number): DescBucket {
  if (len < 500) return 'short';
  if (len <= 2000) return 'medium';
  return 'long';
}

function depthBucket(depth: number): DepthBucket {
  if (depth < 10) return 'shallow';
  if (depth <= 30) return 'medium';
  return 'deep';
}

const DESC_PHRASE: Record<DescBucket, string> = {
  short: 'short descriptions',
  medium: 'medium-length descriptions',
  long: 'long descriptions',
};

const DEPTH_PHRASE: Record<DepthBucket, string> = {
  shallow: 'shallow sessions',
  medium: 'medium-depth sessions',
  deep: 'deep sessions',
};

function detectPatterns(runs: OutlierRun[]): string | null {
  if (runs.length < PATTERN_THRESHOLD) return null;

  const descCounts: Record<DescBucket, number> = { short: 0, medium: 0, long: 0 };
  const depthCounts: Record<DepthBucket, number> = { shallow: 0, medium: 0, deep: 0 };

  for (const r of runs) {
    descCounts[descBucket(r.dimensions.descriptionLen)]++;
    depthCounts[depthBucket(r.dimensions.sessionDepth)]++;
  }

  const descHit = (Object.entries(descCounts) as Array<[DescBucket, number]>).find(
    ([, n]) => n >= PATTERN_THRESHOLD,
  );
  const depthHit = (Object.entries(depthCounts) as Array<[DepthBucket, number]>).find(
    ([, n]) => n >= PATTERN_THRESHOLD,
  );

  const parts: string[] = [];
  if (descHit) parts.push(DESC_PHRASE[descHit[0]]);
  if (depthHit) parts.push(DEPTH_PHRASE[depthHit[0]]);
  if (parts.length === 0) return null;
  return `Common pattern: ${parts.join(' + ')}`;
}

export function OutliersTable({ query, projectSlug }: Props) {
  const { data, isLoading, error } = query;
  const rows = useMemo(() => (data?.runs ?? []).slice(0, ROW_CAP), [data]);
  const pattern = useMemo(() => detectPatterns(data?.runs ?? []), [data]);

  return (
    <Panel
      title="Cost outliers · 30d"
      subtitle="Runs at or above p95 cost"
      right={
        data && data.runs.length > 0 ? (
          <div className="text-right text-[10px] text-outline">
            <div>Threshold (p95): {formatUsd(data.threshold)}</div>
            <div>{data.runs.length} runs</div>
          </div>
        ) : null
      }
    >
      {isLoading ? (
        <LoadingLine />
      ) : error ? (
        <ErrorPill message="Failed to load outliers." />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-outline">No outliers in this window.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-outline-variant/20 text-[10px] uppercase tracking-[0.15em] text-outline">
                  <th className="px-3 py-2 text-left font-medium">Job</th>
                  <th className="px-3 py-2 text-left font-medium">Step</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Desc len</th>
                  <th className="px-3 py-2 text-right font-medium">Session depth</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.jobId}
                    className="border-b border-outline-variant/10 last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-on-surface-variant">
                      {r.issueId ? (
                        <Link
                          href={`/projects/${projectSlug}/issues/${r.issueId}`}
                          className="hover:text-primary"
                          title={r.jobId}
                        >
                          {r.jobId.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span title={r.jobId}>{r.jobId.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-on-surface-variant">{r.state}</td>
                    <td className="px-3 py-2 text-right text-on-surface">
                      {formatUsd(r.cost)}
                    </td>
                    <td className="px-3 py-2 text-right text-on-surface-variant">
                      {r.dimensions.descriptionLen}
                    </td>
                    <td className="px-3 py-2 text-right text-on-surface-variant">
                      {r.dimensions.sessionDepth}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pattern && (
            <p className="mt-3 text-[11px] text-tertiary">{pattern}</p>
          )}
        </>
      )}
    </Panel>
  );
}
