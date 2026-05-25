import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { BlockContributionResponse } from '@/features/analytics/types';

const useBlockContribution = vi.fn();

vi.mock('@/features/analytics/hooks/use-block-contribution', () => ({
  useBlockContribution: (...args: unknown[]) => useBlockContribution(...args),
}));

// Import AFTER the mock is registered.
import { BlockContributionTable } from '@/features/analytics/components/BlockContributionTable';

function makeResp(blocks: BlockContributionResponse['blocks'], runs = blocks.length || 5): BlockContributionResponse {
  return { step: 'code', runs, blocks };
}

function setHook(data: BlockContributionResponse | undefined) {
  useBlockContribution.mockReturnValue({ data, isLoading: false, error: null });
}

function rowIds() {
  const body = screen.getByRole('table').querySelector('tbody');
  if (!body) return [];
  return Array.from(body.querySelectorAll('tr')).map((tr) => {
    const td = tr.querySelector('td');
    return td?.textContent ?? '';
  });
}

beforeEach(() => {
  useBlockContribution.mockReset();
});

describe('BlockContributionTable', () => {
  it('renders the empty state and no <table> when runs === 0', () => {
    setHook(makeResp([], 0));
    render(<BlockContributionTable projectId="p-1" step="code" />);

    expect(
      screen.getByText(/No prompt snapshots yet for this state in the last 30 days/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sorts by pctInput desc by default', () => {
    setHook(
      makeResp([
        { id: 'b-mid', avgTokens: 100, stddev: 10, pctInput: 0.3, cacheHitRate: 0.5 },
        { id: 'b-hi', avgTokens: 100, stddev: 10, pctInput: 0.5, cacheHitRate: 0.5 },
        { id: 'b-lo', avgTokens: 100, stddev: 10, pctInput: 0.1, cacheHitRate: 0.5 },
      ]),
    );
    render(<BlockContributionTable projectId="p-1" step="code" />);

    expect(rowIds()).toEqual(['b-hi', 'b-mid', 'b-lo']);
  });

  it('toggles sort direction and column on header click', () => {
    setHook(
      makeResp([
        { id: 'b-a', avgTokens: 50, stddev: 10, pctInput: 0.3, cacheHitRate: 0.5 },
        { id: 'b-b', avgTokens: 200, stddev: 10, pctInput: 0.2, cacheHitRate: 0.5 },
        { id: 'b-c', avgTokens: 120, stddev: 10, pctInput: 0.1, cacheHitRate: 0.5 },
      ]),
    );
    render(<BlockContributionTable projectId="p-1" step="code" />);

    // Default sort is pctInput desc.
    expect(rowIds()).toEqual(['b-a', 'b-b', 'b-c']);

    const avgHeader = screen.getByText('Avg tokens');
    fireEvent.click(avgHeader);
    // First click on a new column → desc (200, 120, 50).
    expect(rowIds()).toEqual(['b-b', 'b-c', 'b-a']);

    fireEvent.click(avgHeader);
    // Second click on same column → asc (50, 120, 200).
    expect(rowIds()).toEqual(['b-a', 'b-c', 'b-b']);
  });

  it('renders the bloat candidate badge only when avgTokens>0 AND stddev/avg>0.3 AND pctInput>0.3', () => {
    setHook(
      makeResp([
        { id: 'is-bloat', avgTokens: 100, stddev: 40, pctInput: 0.35, cacheHitRate: 0.5 },
        { id: 'low-stddev', avgTokens: 100, stddev: 20, pctInput: 0.35, cacheHitRate: 0.5 },
        { id: 'low-pct', avgTokens: 100, stddev: 40, pctInput: 0.2, cacheHitRate: 0.5 },
        { id: 'zero-avg', avgTokens: 0, stddev: 40, pctInput: 0.35, cacheHitRate: 0.5 },
      ]),
    );
    render(<BlockContributionTable projectId="p-1" step="code" />);

    function rowFor(id: string): HTMLTableRowElement {
      const cell = screen.getByText(id);
      return cell.closest('tr') as HTMLTableRowElement;
    }

    expect(within(rowFor('is-bloat')).getByText('bloat candidate')).toBeInTheDocument();
    expect(within(rowFor('low-stddev')).queryByText('bloat candidate')).toBeNull();
    expect(within(rowFor('low-pct')).queryByText('bloat candidate')).toBeNull();
    // Infinity guard: zero average must NOT flag as bloat even though pctInput > 0.3.
    expect(within(rowFor('zero-avg')).queryByText('bloat candidate')).toBeNull();
  });

  it('renders the cache-hit pill in the right colour band and em-dash for null', () => {
    setHook(
      makeResp([
        { id: 'red', avgTokens: 100, stddev: 0, pctInput: 0.1, cacheHitRate: 0.1 },
        { id: 'amber', avgTokens: 100, stddev: 0, pctInput: 0.1, cacheHitRate: 0.5 },
        { id: 'green', avgTokens: 100, stddev: 0, pctInput: 0.1, cacheHitRate: 0.9 },
        { id: 'null', avgTokens: 100, stddev: 0, pctInput: 0.1, cacheHitRate: null },
      ]),
    );
    render(<BlockContributionTable projectId="p-1" step="code" />);

    function pillFor(id: string): HTMLElement | null {
      const row = screen.getByText(id).closest('tr')!;
      // Cache cell is the 5th td (id, avgTokens, stddev, pctInput, cacheHitRate, flag).
      const tds = row.querySelectorAll('td');
      return tds[4] as HTMLElement | null;
    }

    const redCell = pillFor('red')!;
    expect(redCell.querySelector('span')?.className).toContain('bg-red-100');

    const amberCell = pillFor('amber')!;
    expect(amberCell.querySelector('span')?.className).toContain('bg-amber-100');

    const greenCell = pillFor('green')!;
    expect(greenCell.querySelector('span')?.className).toContain('bg-green-100');

    const nullCell = pillFor('null')!;
    expect(nullCell.textContent).toContain('—');
  });
});
