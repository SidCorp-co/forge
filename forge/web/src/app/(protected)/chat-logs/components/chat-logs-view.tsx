'use client';

import { useState } from 'react';
import { Skeleton } from '@/components/ui';
import { useChatLogs } from '@/features/chat-log/hooks/use-chat-logs';
import { ChatLogsToolbar } from './chat-logs-toolbar';
import { ChatLogsTable } from './chat-logs-table';
import { ChatLogSidePanel } from './chat-log-side-panel';
import { ChatLogReplayModal } from './chat-log-replay-modal';

const DEFAULT_PAGE_SIZE = 25;

export function ChatLogsView() {
  const [projectSlug, setProjectSlug] = useState('all');
  const [intent, setIntent] = useState('all');
  const [source, setSource] = useState('all');
  const [qaRating, setQaRating] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);

  const filters = {
    projectSlug: projectSlug !== 'all' ? projectSlug : undefined,
    intent: intent !== 'all' ? intent : undefined,
    source: source !== 'all' ? source : undefined,
    qaRating: qaRating !== 'all' ? qaRating : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo ? `${dateTo}T23:59:59Z` : undefined,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  const { data, isLoading } = useChatLogs(filters);
  const logs = data?.data ?? [];
  const pagination = data?.meta?.pagination;

  const activeFilterCount = [
    projectSlug !== 'all',
    intent !== 'all',
    source !== 'all',
    qaRating !== 'all',
    !!dateFrom,
    !!dateTo,
  ].filter(Boolean).length;

  function handleFilterChange(key: string, value: string) {
    setPage(1);
    if (key === 'projectSlug') setProjectSlug(value);
    if (key === 'intent') setIntent(value);
    if (key === 'source') setSource(value);
    if (key === 'qaRating') setQaRating(value);
    if (key === 'dateFrom') setDateFrom(value);
    if (key === 'dateTo') setDateTo(value);
  }

  function handleClearFilters() {
    setProjectSlug('all');
    setIntent('all');
    setSource('all');
    setQaRating('all');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-on-surface">Chat Logs</h1>
        <p className="text-sm text-primary-fixed">Review and rate AI chat conversations for quality assurance.</p>
      </div>

      <ChatLogsToolbar
        projectSlug={projectSlug}
        intent={intent}
        source={source}
        qaRating={qaRating}
        dateFrom={dateFrom}
        dateTo={dateTo}
        activeFilterCount={activeFilterCount}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
      />

      <div className="flex min-h-0 gap-4">
        <div className={selectedId ? 'flex-1 min-w-0' : 'w-full'}>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <>
              <ChatLogsTable
                logs={logs}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
              />
              {pagination && pagination.pageCount > 1 && (
                <div className="mt-3 flex items-center justify-between text-xs text-primary-fixed">
                  <span>{pagination.total} total</span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                      className="rounded border border-outline-variant/30 px-2.5 py-1 hover:bg-surface-container-low disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <span>
                      {page} / {pagination.pageCount}
                    </span>
                    <button
                      disabled={page >= pagination.pageCount}
                      onClick={() => setPage((p) => p + 1)}
                      className="rounded border border-outline-variant/30 px-2.5 py-1 hover:bg-surface-container-low disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {selectedId && (
          <div className="w-80 shrink-0 xl:w-96">
            <ChatLogSidePanel
              logId={selectedId}
              onClose={() => setSelectedId(null)}
              onOpenReplay={(id) => setReplayId(id)}
            />
          </div>
        )}
      </div>

      {replayId && (
        <ChatLogReplayModal
          logId={replayId}
          onClose={() => setReplayId(null)}
        />
      )}
    </div>
  );
}
