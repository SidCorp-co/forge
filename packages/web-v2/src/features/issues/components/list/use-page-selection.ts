"use client";

import { useState } from "react";
import { useIdSet } from "@/design";
import { useIssueSelectionBridge } from "@/features/chat-dock";
import type { IssueRow } from "../../types";

/** The rows ticked for a bulk act on this page; any change of view, named by `viewKey`, clears them. */
export function usePageSelection(rows: IssueRow[], viewKey: string) {
  const picked = useIdSet();
  const [shownView, setShownView] = useState(viewKey);
  if (shownView !== viewKey) {
    setShownView(viewKey);
    picked.reset();
  }
  const pageIds = rows.map((r) => r.id);
  const selectedCount = pageIds.filter(picked.has).length;
  const allOnPageSelected = pageIds.length > 0 && selectedCount === pageIds.length;
  const selectedRows = rows.filter((r) => picked.has(r.id));
  useIssueSelectionBridge(rows, selectedRows, picked.reset);
  return {
    selected: picked.ids,
    toggleRow: picked.toggle,
    clearSelection: () => picked.reset(),
    allOnPageSelected,
    someOnPageSelected: selectedCount > 0 && !allOnPageSelected,
    toggleAllOnPage: (next: boolean) => picked.reset(next ? pageIds : []),
    selectedRows,
  };
}
