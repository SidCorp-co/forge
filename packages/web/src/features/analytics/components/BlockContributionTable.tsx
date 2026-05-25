'use client';

import { useMemo, useState } from 'react';
import { useBlockContribution } from '../hooks/use-block-contribution';
import type { BlockContributionRow } from '../types';

interface Props {
  projectId: string;
  step: string;
  days?: number;
}

type SortCol = 'id' | 'avgTokens' | 'stddev' | 'pctInput' | 'cacheHitRate';
type SortState = { col: SortCol; dir: 'asc' | 'desc' };

const COLUMNS: ReadonlyArray<{ col: SortCol; label: string; align: 'left' | 'right' }> = [
  { col: 'id', label: 'Block id', align: 'left' },
  { col: 'avgTokens', label: 'Avg tokens', align: 'right' },
  { col: 'stddev', label: 'Stddev', align: 'right' },
  { col: 'pctInput', label: '% of input', align: 'right' },
  { col: 'cacheHitRate', label: 'Cache hit', align: 'right' },
];

function cachePillClass(rate: number | null): string {
  if (rate === null) return 'text-gray-400';
  if (rate < 0.3) return 'bg-red-100 text-red-700';
  if (rate < 0.7) return 'bg-amber-100 text-amber-700';
  return 'bg-green-100 text-green-700';
}

function isBloatCandidate(row: BlockContributionRow): boolean {
  // Guard avg > 0 first to avoid Infinity when a block reports zero estTokens.
  if (row.avgTokens <= 0) return false;
  return row.stddev / row.avgTokens > 0.3 && row.pctInput > 0.3;
}

function compareRows(a: BlockContributionRow, b: BlockContributionRow, sort: SortState): number {
  const dir = sort.dir === 'asc' ? 1 : -1;
  if (sort.col === 'id') return a.id.localeCompare(b.id) * dir;
  if (sort.col === 'cacheHitRate') {
    // Push nulls to the end regardless of direction.
    const av = a.cacheHitRate;
    const bv = b.cacheHitRate;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * dir;
  }
  return (a[sort.col] - b[sort.col]) * dir;
}

export function BlockContributionTable({ projectId, step, days = 30 }: Props) {
  const { data, isLoading, error } = useBlockContribution(projectId, step, days);
  const [sort, setSort] = useState<SortState>({ col: 'pctInput', dir: 'desc' });

  const sortedBlocks = useMemo<BlockContributionRow[]>(() => {
    if (!data?.blocks) return [];
    return [...data.blocks].sort((a, b) => compareRows(a, b, sort));
  }, [data?.blocks, sort]);

  function onHeaderClick(col: SortCol) {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: 'desc' },
    );
  }

  if (isLoading) {
    return (
      <section className="rounded-md border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-medium text-gray-700">Block contribution — {step}</h3>
        <p className="mt-2 text-sm text-gray-500">Loading…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-md border border-red-200 bg-red-50 p-4">
        <h3 className="text-sm font-medium text-red-700">Block contribution — {step}</h3>
        <p className="mt-2 text-sm text-red-600">Failed to load block contribution.</p>
      </section>
    );
  }

  const runs = data?.runs ?? 0;

  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-gray-700">
          Block contribution — {step} · {runs} runs
        </h3>
      </header>

      {runs === 0 ? (
        <p className="mt-2 text-sm text-gray-500">
          No prompt snapshots yet for this state in the last {days} days.
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              {COLUMNS.map((c) => (
                <th
                  key={c.col}
                  scope="col"
                  className={`cursor-pointer select-none py-2 font-medium ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                  onClick={() => onHeaderClick(c.col)}
                >
                  {c.label}
                  {sort.col === c.col ? (
                    <span className="ml-1 text-gray-400">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                  ) : null}
                </th>
              ))}
              <th scope="col" className="py-2 text-right text-xs font-medium uppercase text-gray-500">
                Flag
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedBlocks.map((row) => {
              const bloat = isBloatCandidate(row);
              return (
                <tr key={row.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="py-2 font-mono text-gray-800">{row.id}</td>
                  <td className="py-2 text-right tabular-nums text-gray-800">
                    {Math.round(row.avgTokens)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-800">
                    {Math.round(row.stddev)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-800">
                    {(row.pctInput * 100).toFixed(1)}%
                  </td>
                  <td className="py-2 text-right">
                    {row.cacheHitRate === null ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${cachePillClass(
                          row.cacheHitRate,
                        )}`}
                      >
                        {(row.cacheHitRate * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {bloat ? (
                      <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                        bloat candidate
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
