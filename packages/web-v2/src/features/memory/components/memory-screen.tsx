"use client";

// Project-tier Memory (`/v2/projects/[slug]/memory`). Searchable list of system
// breadcrumbs (issue/comment/job/note/decision/policy/knowledge). Empty query →
// paginated list; a term → semantic search hits. ISS-299.
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Input,
  MonoTag,
  Pagination,
  Select,
  Skeleton,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { MEMORY_PAGE_SIZE } from "../api";
import { useMemoryList, useMemorySearch } from "../hooks";
import { MEMORY_SOURCES, sourceTone, type MemorySource } from "../types";

interface MemoryScreenProps {
  scope: { projectId: string };
}

const SOURCE_OPTIONS: SelectOption[] = [
  { value: "", label: "All sources" },
  ...MEMORY_SOURCES.map((s) => ({ value: s, label: s })),
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

interface BreadcrumbItem {
  id: string;
  source: MemorySource;
  sourceRef: string | null;
  text: string;
  createdAt?: string | null;
  score?: number;
}

export function MemoryScreen({ scope }: MemoryScreenProps) {
  const { projectId } = scope;
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);

  const debouncedQuery = useDebounced(query, 300);
  const searching = debouncedQuery.trim().length > 0;

  // Reset to page 1 when the source filter changes.
  useEffect(() => setPage(1), [source]);

  const sourceFilter = source ? [source as MemorySource] : undefined;
  const listQ = useMemoryList({ projectId, source: source as MemorySource | undefined, page });
  const searchQ = useMemorySearch(projectId, debouncedQuery, sourceFilter);

  const active = searching ? searchQ : listQ;

  const items = useMemo<BreadcrumbItem[]>(() => {
    if (searching) {
      return (searchQ.data?.hits ?? []).map((h) => ({
        id: h.id,
        source: h.source,
        sourceRef: h.sourceRef,
        text: h.text,
        score: h.score,
      }));
    }
    return (listQ.data?.items ?? []).map((r) => ({
      id: r.id,
      source: r.source,
      sourceRef: r.sourceRef,
      text: r.textContent,
      createdAt: r.createdAt,
    }));
  }, [searching, searchQ.data, listQ.data]);

  const totalCount = listQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / MEMORY_PAGE_SIZE));

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Memory</h1>
        <p className="fg-body-sm mt-1">
          System breadcrumbs the pipeline writes as it works — searchable across this project.
        </p>
      </header>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            icon="search"
            value={query}
            placeholder="Search memory…"
            aria-label="Search memory"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sm:w-52">
          <Select options={SOURCE_OPTIONS} value={source} onChange={setSource} placeholder="All sources" />
        </div>
      </div>

      {active.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      )}

      {active.isError && (
        <ErrorState
          title="Couldn't load memory"
          message={formatApiError(active.error)}
          onRetry={() => active.refetch()}
        />
      )}

      {!active.isLoading && !active.isError && items.length === 0 && (
        <EmptyState
          title={searching ? "No matches" : "No memory yet"}
          message={
            searching
              ? "No breadcrumbs match this search."
              : "Breadcrumbs from issues, comments, jobs, and decisions will appear here."
          }
          mascot={!searching}
        />
      )}

      {!active.isLoading && !active.isError && items.length > 0 && (
        <div className="space-y-2.5">
          {items.map((item) => (
            <MemoryCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {!searching && !active.isLoading && !active.isError && totalCount > MEMORY_PAGE_SIZE && (
        <div className="mt-6 flex justify-center">
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

function MemoryCard({ item }: { item: BreadcrumbItem }) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={sourceTone(item.source)}>{item.source}</Badge>
            {item.sourceRef && <MonoTag>{item.sourceRef}</MonoTag>}
          </div>
          {item.score != null ? (
            <span className="fg-caption font-mono">{item.score.toFixed(3)}</span>
          ) : item.createdAt ? (
            <span className="fg-caption font-mono">
              {new Date(item.createdAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          ) : null}
        </div>
        <p className="fg-body-sm mt-2 line-clamp-4 text-fg">{item.text}</p>
      </CardContent>
    </Card>
  );
}
