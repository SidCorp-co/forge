'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { useIssueSearch, usePatchIssue } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import { PAGE_SIZE, type SortOption, type ViewMode } from '../constants';

export function useIssuesPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);

  const statusParam = searchParams.get('status') ?? '';
  const statusFilter = statusParam ? statusParam.split(',') : [];
  const priorityParam = searchParams.get('priority') ?? 'all';
  const priorityFilter = priorityParam === 'all' ? [] : [priorityParam];
  const sortBy = (searchParams.get('sort') ?? 'newest') as SortOption;
  const searchQuery = searchParams.get('q') ?? '';
  const currentPage = Number(searchParams.get('page') ?? '1');

  // Use `search` endpoint since it accepts multi-value status/priority and
  // supports `q` (ILIKE on title + description).
  const { data: paginatedData, isLoading } = useIssueSearch({
    projectId: projectId ?? '',
    ...(searchQuery ? { q: searchQuery } : {}),
    ...(statusFilter.length > 0 ? { status: statusFilter } : {}),
    ...(priorityFilter.length > 0 ? { priority: priorityFilter } : {}),
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });

  const issues: Issue[] = paginatedData?.items ?? [];
  const total = paginatedData?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(currentPage, pageCount);

  const patchIssue = usePatchIssue();

  // `category` filter is not a first-class server filter on core yet. Core
  // exposes free-form `category` as a column; the old Strapi `$eq` path has
  // no direct equivalent without a dedicated endpoint. We keep the list
  // derived from visible issues so the filter dropdown still works against
  // what the user can see.
  const categories = useMemo(
    () =>
      [
        ...new Set(issues.map((i) => i.category).filter((c): c is string => !!c)),
      ].sort(),
    [issues],
  );

  const activeFilterCount = [
    statusFilter.length > 0,
    priorityFilter.length > 0,
  ].filter(Boolean).length;

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all' || value === '' || value === 'newest') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      if (key !== 'page') params.delete('page');
      const qs = params.toString();
      router.replace(`/projects/${slug}/issues${qs ? `?${qs}` : ''}`);
    },
    [searchParams, router, slug],
  );

  const handleUpdate = useCallback(
    (id: string, patch: IssuePatchInput) => {
      patchIssue.mutate({ id, patch });
    },
    [patchIssue],
  );

  const handleBulkUpdate = useCallback(
    (patch: IssuePatchInput) => {
      for (const id of checked) {
        patchIssue.mutate({ id, patch });
      }
      setChecked(new Set());
    },
    [checked, patchIssue],
  );

  function toggleCheck(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleStartSession() {
    // No-op: the old agentApi.triggerPipeline has no core equivalent.
    // Server-side pipeline/orchestrator dispatches jobs on transitions,
    // so this action is covered automatically once transitions happen.
    setChecked(new Set());
  }

  return {
    slug,
    issues,
    isLoading,
    viewMode,
    setViewMode,
    selectedIssueId,
    setSelectedIssueId,
    statusFilter,
    priorityFilter: (priorityFilter[0] ?? 'all') as string,
    categoryFilter: 'all',
    sortBy,
    searchQuery,
    categories,
    activeFilterCount,
    filtersOpen,
    setFiltersOpen,
    setParam,
    checked,
    setChecked,
    toggleCheck,
    filtered: issues,
    paginated: issues,
    pageCount,
    safePage,
    total,
    handleUpdate,
    handleBulkUpdate,
    handleStartSession,
    desktopConnected: false,
    isBuildingPrompt: false,
  };
}
