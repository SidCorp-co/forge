"use client";

import { useIssueSelectionBridge } from "@/features/chat-dock/selection-bridge";
import { useEffect, useState } from "react";
import type { IssueRow } from "../../types";

/** The rows ticked for a bulk act on this page; any change of view, named by `viewKey`, clears them. */
export function usePageSelection(rows: IssueRow[], viewKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on any view change, not on `selected` itself.
  useEffect(() => {
    setSelected(new Set());
  }, [viewKey]);

  const toggleRow = (id: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const pageIds = rows.map((r) => r.id);
  const selectedCount = pageIds.filter((id) => selected.has(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedCount === pageIds.length;
  const someOnPageSelected = selectedCount > 0 && !allOnPageSelected;
  const toggleAllOnPage = (next: boolean) => setSelected(next ? new Set(pageIds) : new Set());
  const selectedRows = rows.filter((r) => selected.has(r.id));
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
