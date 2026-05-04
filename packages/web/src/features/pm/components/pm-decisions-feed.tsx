'use client';

import { useState } from 'react';
import { usePmDecisions } from '../hooks/use-pm-decisions';

const PAGE_SIZE = 25;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PmDecisionsFeed({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = usePmDecisions(projectId, page, PAGE_SIZE);
  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <section className="space-y-3 rounded-lg border border-outline-variant/30 bg-surface-container-low p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-on-surface">Decisions</h2>
        <span className="text-xs text-outline">{totalCount} total</span>
      </header>

      {isLoading && <p className="text-sm text-outline">Loading…</p>}
      {!isLoading && items.length === 0 && (
        <p className="text-sm text-outline">No decisions recorded yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-outline-variant/30">
          {items.map((d) => (
            <li key={d.id} className="space-y-1 py-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                  {d.cause}
                </span>
                {d.confidence !== null && (
                  <span className="text-[10px] text-outline">
                    confidence {(d.confidence * 100).toFixed(0)}%
                  </span>
                )}
                {d.modelTier && (
                  <span className="text-[10px] text-outline">
                    {d.modelTier}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-outline">
                  {timeAgo(d.createdAt)}
                </span>
              </div>
              <p className="text-sm text-on-surface">{d.summary}</p>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-on-surface-variant">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded border border-outline-variant px-2 py-1 disabled:opacity-50"
          >
            Prev
          </button>
          <span>
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded border border-outline-variant px-2 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
