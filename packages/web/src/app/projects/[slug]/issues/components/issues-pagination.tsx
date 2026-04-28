'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface IssuesPaginationProps {
  total: number;
  pageCount: number;
  safePage: number;
  setParam: (key: string, value: string) => void;
}

export function IssuesPagination({
  total,
  pageCount,
  safePage,
  setParam,
}: IssuesPaginationProps) {
  return (
    <div className="border-t border-surface-container-high px-4 py-2 flex items-center justify-between text-xs text-primary-fixed">
      <span>
        {total} issue{total !== 1 ? 's' : ''}
        {pageCount > 1 && ` — page ${safePage} of ${pageCount}`}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setParam('page', String(safePage - 1))}
            disabled={safePage <= 1}
            aria-label="Previous page"
            className="rounded-sm p-1 text-outline hover:bg-surface-container-high hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {Array.from({ length: pageCount }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === pageCount || Math.abs(p - safePage) <= 1)
            .reduce<(number | 'ellipsis')[]>((acc, p, idx, arr) => {
              if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('ellipsis');
              acc.push(p);
              return acc;
            }, [])
            .map((p, idx) =>
              p === 'ellipsis' ? (
                <span key={`e${idx}`} className="px-1 text-outline-variant">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setParam('page', String(p))}
                  className={cn(
                    'min-w-[28px] rounded-sm px-1.5 py-0.5 transition-colors',
                    p === safePage ? 'bg-surface-container-high font-medium text-on-surface' : 'text-outline hover:bg-surface-container-low hover:text-on-surface',
                  )}
                >
                  {p}
                </button>
              ),
            )}
          <button
            onClick={() => setParam('page', String(safePage + 1))}
            disabled={safePage >= pageCount}
            aria-label="Next page"
            className="rounded-sm p-1 text-outline hover:bg-surface-container-high hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
