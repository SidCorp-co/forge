'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useChatLogs } from '@/features/chat-log/hooks/use-chat-logs';
import { useProjects } from '@/features/project/hooks/use-projects';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';
import { cn } from '@/lib/utils/cn';
import { ChatLogsTable } from './chat-logs-table';
import { ChatLogSidePanel } from './chat-log-side-panel';
import { ChatLogReplayModal } from './chat-log-replay-modal';
import type { ChatLogFilters } from '@/features/chat-log/types';

const INTENT_OPTIONS = ['', 'SEARCH', 'LOOKUP', 'CREATE', 'SUMMARY', 'ACTION', 'CHAT'];
const SOURCE_OPTIONS = ['', 'web', 'cli', 'mcp', 'api'];
const RATING_OPTIONS = ['', 'good', 'bad', 'flagged'];

export function ChatLogsView() {
  const { data: projects } = useProjects();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Omit<ChatLogFilters, 'page' | 'pageSize'>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);

  const query = useChatLogs({ ...filters, page, pageSize: 25 });
  const logs = query.data?.data ?? [];
  const pagination = query.data?.meta?.pagination;

  function updateFilter<K extends keyof typeof filters>(key: K, value: string) {
    setPage(1);
    setFilters((prev) => {
      const next = { ...prev };
      if (value) (next as Record<string, string>)[key] = value;
      else delete (next as Record<string, string>)[key];
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-outline-variant/30 bg-surface-container-low px-6 py-3">
        <h1 className="text-lg font-semibold text-on-surface">Chat logs</h1>
        <p className="text-xs text-primary-fixed">
          Browse and rate chat agent responses across all projects.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/30 bg-surface-container-low px-6 py-3">
        <select
          value={filters.projectSlug ?? ''}
          onChange={(e) => updateFilter('projectSlug', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface px-2 py-1.5 text-xs"
        >
          <option value="">All projects</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={filters.intent ?? ''}
          onChange={(e) => updateFilter('intent', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface px-2 py-1.5 text-xs"
        >
          {INTENT_OPTIONS.map((i) => (
            <option key={i} value={i}>
              {i || 'Any intent'}
            </option>
          ))}
        </select>
        <select
          value={filters.source ?? ''}
          onChange={(e) => updateFilter('source', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface px-2 py-1.5 text-xs"
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s || 'Any source'}
            </option>
          ))}
        </select>
        <select
          value={filters.qaRating ?? ''}
          onChange={(e) => updateFilter('qaRating', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface px-2 py-1.5 text-xs"
        >
          {RATING_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r || 'Any rating'}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
          {query.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : query.error ? (
            <p className="text-[10px] uppercase tracking-widest text-error">
              {formatApiError(query.error)}
            </p>
          ) : (
            <>
              <ChatLogsTable
                logs={logs}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
              />
              {pagination && pagination.pageCount > 1 && (
                <div className="mt-3 flex items-center justify-end gap-2 text-xs text-primary-fixed">
                  <span>
                    Page {pagination.page} of {pagination.pageCount} · {pagination.total} total
                  </span>
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={cn(
                      'rounded border border-outline-variant/30 p-1 hover:bg-surface-container-high',
                      page <= 1 && 'opacity-40',
                    )}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={page >= pagination.pageCount}
                    onClick={() => setPage((p) => p + 1)}
                    className={cn(
                      'rounded border border-outline-variant/30 p-1 hover:bg-surface-container-high',
                      page >= pagination.pageCount && 'opacity-40',
                    )}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {selectedId && (
          <div className="hidden w-96 shrink-0 md:block">
            <ChatLogSidePanel
              logId={selectedId}
              onClose={() => setSelectedId(null)}
              onOpenReplay={(id) => setReplayId(id)}
            />
          </div>
        )}
      </div>

      {replayId && (
        <ChatLogReplayModal logId={replayId} onClose={() => setReplayId(null)} />
      )}
    </div>
  );
}

export default ChatLogsView;
