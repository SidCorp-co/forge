"use client";

// Project-tier Memory (`/v2/projects/[slug]/memory`). Searchable list of system
// breadcrumbs (issue/comment/job/note/decision/policy/knowledge). Empty query →
// paginated list; a term → semantic search hits. ISS-299.
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Card,
  CardContent,
  Divider,
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
  const filtered = searching || source !== "";

  const ready = !active.isLoading && !active.isError;

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Memory</h1>
        <p className="fg-body-sm mt-1">
          System breadcrumbs the pipeline writes as it works — searchable across this project.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          icon="search"
          value={query}
          placeholder="Search memory…"
          aria-label="Search memory"
          onChange={(e) => setQuery(e.target.value)}
          className="w-full sm:w-72"
        />
        <Select
          options={SOURCE_OPTIONS}
          value={source}
          onChange={setSource}
          placeholder="All sources"
          aria-label="Filter by source"
          className="w-full sm:w-48"
        />
        {ready && items.length > 0 && (
          <p className="fg-caption ml-auto text-subtle">
            {searching
              ? `${items.length} match${items.length === 1 ? "" : "es"}`
              : `${totalCount} breadcrumb${totalCount === 1 ? "" : "s"}`}
          </p>
        )}
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

      {ready && items.length === 0 && (
        <EmptyState
          title={filtered ? "Nothing here" : "No memory yet"}
          message={
            filtered
              ? "No breadcrumbs match these filters."
              : "Breadcrumbs from issues, comments, jobs, and decisions will appear here."
          }
          mascot={!filtered}
        />
      )}

      {ready && items.length > 0 && (
        <div className="space-y-2.5">
          {items.map((item) => (
            <MemoryCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {!searching && ready && totalCount > MEMORY_PAGE_SIZE && (
        <div className="mt-6 flex justify-center">
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

function MemoryCard({ item }: { item: BreadcrumbItem }) {
  const meta =
    item.score != null
      ? { label: item.score.toFixed(3), title: "Match score" }
      : item.createdAt
        ? {
            label: new Date(item.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            }),
            title: "Recorded",
          }
        : null;

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-2">
          <Badge tone={sourceTone(item.source)}>{item.source}</Badge>
          {item.sourceRef && <MonoTag>{item.sourceRef}</MonoTag>}
          {meta && (
            <span className="fg-mono ml-auto text-subtle tabular-nums" title={meta.title}>
              {meta.label}
            </span>
          )}
        </div>
        <Divider className="my-3" />
        <p className="fg-body-sm line-clamp-4 text-fg">{item.text}</p>
      </CardContent>
    </Card>
  );
}
