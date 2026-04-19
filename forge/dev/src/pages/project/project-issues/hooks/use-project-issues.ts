import { useState, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getIssues, updateIssue, enrichIssue } from "@/lib/api";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import type { Issue, IssueStatus, IssuePriority } from "@/lib/types";
import { ALL_STATUSES, ALL_PRIORITIES, PRIORITY_ORDER } from "@/lib/constants";

export type SortOption = "newest" | "oldest" | "priority" | "updated";

export function useProjectIssues() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Issue | null>(null);
  const [statusFilter, setStatusFilter] = useState<IssueStatus[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [searchQuery, setSearchQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  const pageSize = 10;

  const { data: issues, isLoading, refetch } = useQuery({
    queryKey: ["issues", slug],
    queryFn: () => getIssues(slug!),
    enabled: !!slug,
  });

  const updateMutation = useOptimisticMutation<Issue, { id: string; data: Partial<Issue> }>({
    queryKey: ["issues", slug],
    mutationFn: ({ id, data }) => updateIssue(id, data),
    updateData: (old, { id, data }) => old?.map((i) => (i.documentId === id ? { ...i, ...data } : i)),
  });

  const enrichMutation = useMutation({
    mutationFn: (documentId: string) => enrichIssue(documentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["issues", slug], refetchType: "all" }),
  });

  const handleUpdate = useCallback(
    (id: string, data: Partial<Issue>) => {
      updateMutation.mutate({ id, data });
    },
    [updateMutation],
  );

  const handleBulkUpdate = useCallback(
    (data: Partial<Issue>) => {
      for (const id of checked) {
        updateMutation.mutate({ id, data });
      }
      setChecked(new Set());
    },
    [checked, updateMutation],
  );

  function toggleCheck(docId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function handleStartSession() {
    if (!slug || checked.size === 0) return;
    const ids = Array.from(checked).join(",");
    navigate(`/project/${slug}/agent?issueIds=${encodeURIComponent(ids)}`);
  }

  const categories = useMemo(
    () => [...new Set((issues ?? []).map((i) => i.category).filter(Boolean))].sort() as string[],
    [issues],
  );

  const filtered = useMemo(() => {
    if (!issues) return [];
    let result = issues.filter((i) => {
      if (statusFilter.length > 0 && !statusFilter.includes(i.status)) return false;
      if (priorityFilter !== "all" && i.priority !== priorityFilter) return false;
      if (categoryFilter !== "all" && i.category !== categoryFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!i.title.toLowerCase().includes(q) && !i.description?.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    result.sort((a, b) => {
      switch (sortBy) {
        case "oldest": return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "priority": return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        case "updated": return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        default: return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

    return result;
  }, [issues, statusFilter, priorityFilter, categoryFilter, sortBy, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedIssues = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    setPage(1);
  }

  function handleStatusFilterChange(value: IssueStatus[]) {
    setStatusFilter(value);
    setPage(1);
  }

  function handlePriorityFilterChange(value: IssuePriority | "all") {
    setPriorityFilter(value);
    setPage(1);
  }

  function handleCategoryFilterChange(value: string) {
    setCategoryFilter(value);
    setPage(1);
  }

  function handleSortChange(value: SortOption) {
    setSortBy(value);
    setPage(1);
  }

  return {
    slug,
    issues,
    isLoading,
    refetch,
    selected,
    setSelected,
    checked,
    setChecked,
    toggleCheck,
    handleUpdate,
    handleBulkUpdate,
    handleStartSession,
    enrichMutation,
    // filter/sort state
    statusFilter,
    priorityFilter,
    categoryFilter,
    sortBy,
    searchQuery,
    categories,
    handleSearchChange,
    handleStatusFilterChange,
    handlePriorityFilterChange,
    handleCategoryFilterChange,
    handleSortChange,
    // pagination
    filtered,
    paginatedIssues,
    currentPage,
    totalPages,
    setPage,
    // constants
    ALL_STATUSES,
    ALL_PRIORITIES,
  };
}
