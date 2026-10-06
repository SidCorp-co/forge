"use client";

import { useIssueSelectionBridge } from "@/features/chat-dock/selection-bridge";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { IssueRow } from "../../types";

/** The rows ticked for a bulk act on this page; any change of view, named by `viewKey`, clears them. */
export function usePageSelection(rows: IssueRow[], viewKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on any view change, not on `selected` itself.
  useEffect(() => {
    setSelected(new Set());
  }, [viewKey]);

  const toggleRow = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedCount = useMemo(
    () => pageIds.filter((id) => selected.has(id)).length,
    [pageIds, selected],
  );
  const allOnPageSelected = pageIds.length > 0 && selectedCount === pageIds.length;
  const someOnPageSelected = selectedCount > 0 && !allOnPageSelected;
  const toggleAllOnPage = useCallback(
    (next: boolean) => setSelected(next ? new Set(pageIds) : new Set()),
    [pageIds],
  );
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  useIssueSelectionBridge(rows, selectedRows, setSelected);

  return {
    selected,
    toggleRow,
    clearSelection,
    allOnPageSelected,
    someOnPageSelected,
    toggleAllOnPage,
    selectedRows,
  };
}
