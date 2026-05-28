'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Brain, Search, Trash2 } from 'lucide-react';
import {
  useDeleteMemory,
  useMemories,
  useMemorySearch,
} from '@/features/memory/hooks/use-memories';
import { MEMORY_SOURCES, type MemorySource } from '@/features/memory/types';
import { ApiError } from '@/lib/api/client';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';

const SOURCE_CONFIG: Record<MemorySource, { label: string; bg: string; text: string }> = {
  issue: { label: 'Issue', bg: 'bg-info/20', text: 'text-info' },
  comment: { label: 'Comment', bg: 'bg-primary/20', text: 'text-primary' },
  job: { label: 'Job', bg: 'bg-warning/20', text: 'text-warning' },
  note: { label: 'Note', bg: 'bg-tertiary/20', text: 'text-tertiary' },
  knowledge: { label: 'Knowledge', bg: 'bg-success/20', text: 'text-success' },
  decision: { label: 'Decision', bg: 'bg-secondary/20', text: 'text-secondary' },
  policy: { label: 'Policy', bg: 'bg-error/20', text: 'text-error' },
};

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All sources' },
  ...MEMORY_SOURCES.map((s) => ({ value: s, label: SOURCE_CONFIG[s].label })),
];

function SourceBadge({ source }: { source: MemorySource }) {
  const cfg = SOURCE_CONFIG[source] ?? { label: source, bg: 'bg-outline/20', text: 'text-outline' };
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

function formatDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Normalized row rendered by the table — covers both list rows and search hits. */
interface DisplayRow {
  id: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata: Record<string, unknown> | null;
  date: string;
  score?: number;
}

interface MemoryViewProps {
  projectDocumentId?: string;
  slug: string;
}

export function MemoryView({ projectDocumentId, slug }: MemoryViewProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const deleteMemory = useDeleteMemory();

  // Debounce the search input (no shared util exists).
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const source = sourceFilter === 'all' ? undefined : (sourceFilter as MemorySource);
  const isSearchMode = debouncedQuery.length > 0;

  const listQuery = useMemories({ projectId: projectDocumentId, source });
  const searchQuery = useMemorySearch({
    projectId: projectDocumentId,
    query: isSearchMode ? debouncedQuery : '',
    sourceFilter: source ? [source] : undefined,
  });

  const rows: DisplayRow[] = useMemo(() => {
    if (isSearchMode) {
      return (searchQuery.data?.hits ?? []).map((h) => ({
        id: h.id,
        source: h.source,
        sourceRef: h.sourceRef,
        text: h.text,
        metadata: h.metadata,
        date: h.embeddedAt,
        score: h.score,
      }));
    }
    return (listQuery.data?.items ?? []).map((r) => ({
      id: r.id,
      source: r.source,
      sourceRef: r.sourceRef,
      text: r.textContent,
      metadata: r.metadata,
      date: r.createdAt,
    }));
  }, [isSearchMode, searchQuery.data, listQuery.data]);

  const sourceCounts = useMemo(() => {
    const counts = {} as Record<MemorySource, number>;
    for (const s of MEMORY_SOURCES) counts[s] = 0;
    for (const r of listQuery.data?.items ?? []) {
      counts[r.source] = (counts[r.source] ?? 0) + 1;
    }
    return counts;
  }, [listQuery.data]);

  const isLoading = isSearchMode ? searchQuery.isLoading : listQuery.isLoading;
  const totalCount = listQuery.data?.totalCount ?? 0;

  const embeddingsUnavailable =
    isSearchMode && searchQuery.error instanceof ApiError && searchQuery.error.status === 503;
  const searchFailed = isSearchMode && !!searchQuery.error && !embeddingsUnavailable;

  function handleDelete(id: string) {
    if (!confirm('Delete this memory? This cannot be undone.')) return;
    deleteMemory.mutate(id);
  }

  function renderSourceRef(row: DisplayRow) {
    if (row.source === 'issue') {
      return (
        <Link href={`/projects/${slug}/issues/${row.sourceRef}`} className="text-primary hover:underline">
          {row.sourceRef.slice(0, 8)}
        </Link>
      );
    }
    if (row.source === 'comment') {
      const issueId = row.metadata?.issueId;
      if (typeof issueId === 'string' && issueId) {
        return (
          <Link href={`/projects/${slug}/issues/${issueId}`} className="text-primary hover:underline">
            {row.sourceRef.slice(0, 8)}
          </Link>
        );
      }
    }
    return <span className="text-outline">{row.sourceRef.slice(0, 12)}</span>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-on-surface">Memory</h1>
        <p className="text-sm text-primary-fixed">Indexed project memory the agent searches over</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {isSearchMode ? (
          <StatCard label="Results" value={rows.length} accent="text-primary" />
        ) : (
          <>
            <StatCard label="Total" value={totalCount} />
            {MEMORY_SOURCES.map((s) => (
              <StatCard key={s} label={SOURCE_CONFIG[s].label} value={sourceCounts[s]} accent={SOURCE_CONFIG[s].text} />
            ))}
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-outline" />
          <input
            type="text"
            placeholder="Semantic search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded border border-outline-variant/30 bg-surface-container-low pl-8 pr-3 text-xs text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </div>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="h-8 rounded border border-outline-variant/30 bg-surface-container-low px-2 text-xs text-on-surface focus:border-primary focus:outline-none"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Embeddings-unavailable banner (non-fatal) */}
      {embeddingsUnavailable && (
        <div className="flex items-center gap-2 rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Semantic search is temporarily unavailable (embeddings service down). Clear the search to browse the full list.</span>
        </div>
      )}
      {searchFailed && (
        <div className="flex items-center gap-2 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Search failed. Try again or clear the query to browse the list.</span>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-surface-container-low" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-8 w-8" />}
          title={isSearchMode ? 'No matches' : 'No memories yet'}
          description={
            isSearchMode
              ? 'No indexed memory matched your search. Try different wording or clear the query.'
              : 'Indexed memory will appear here as the agent records issues, comments, decisions and notes.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-sm border border-outline-variant/20">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/20 bg-surface-container-low text-[10px] uppercase tracking-wider text-primary-fixed">
                <th className="px-3 py-2 sm:px-4">Content</th>
                <th className="px-3 py-2">Source</th>
                <th className="hidden px-3 py-2 sm:table-cell">Ref</th>
                {isSearchMode ? (
                  <th className="hidden px-3 py-2 sm:table-cell">Score</th>
                ) : (
                  <th className="hidden px-3 py-2 md:table-cell">Created</th>
                )}
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {rows.map((row) => (
                <tr key={row.id} className="group hover:bg-surface-container-low/50">
                  <td className="max-w-md px-3 py-2.5 sm:px-4">
                    <p className="line-clamp-2 text-on-surface">{row.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:hidden">
                      <SourceBadge source={row.source} />
                      {renderSourceRef(row)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <SourceBadge source={row.source} />
                  </td>
                  <td className="hidden px-3 py-2.5 tabular-nums sm:table-cell">{renderSourceRef(row)}</td>
                  {isSearchMode ? (
                    <td className="hidden px-3 py-2.5 tabular-nums text-outline sm:table-cell">
                      {row.score !== undefined ? `${(row.score * 100).toFixed(0)}%` : '—'}
                    </td>
                  ) : (
                    <td className="hidden px-3 py-2.5 text-outline md:table-cell">{formatDate(row.date)}</td>
                  )}
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => handleDelete(row.id)}
                      disabled={deleteMemory.isPending}
                      className="rounded p-1 text-outline opacity-0 transition-opacity hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:opacity-50"
                      title="Delete memory"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
