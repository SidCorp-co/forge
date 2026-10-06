"use client";

// the Issues list owns its row selection as local state; this bridge is the one way the chat's
// ui.select reaches it, and the absence of a registered list is how ui.select learns it must refuse.

import { useEffect, useRef, useSyncExternalStore } from "react";

interface SelectableRow {
  id: string;
  displayId: string;
}

export interface IssueSelectionBridge {
  rows: () => readonly SelectableRow[];
  selectedKeys: () => string[];
  setSelectedIds: (ids: Set<string>) => void;
}

let current: IssueSelectionBridge | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version += 1;
  for (const l of listeners) l();
};

export function issueSelectionBridge(): IssueSelectionBridge | null {
  return current;
}

export function useIssueSelectionBridge(
  rows: readonly SelectableRow[],
  selectedRows: readonly SelectableRow[],
  setSelected: (ids: Set<string>) => void,
): void {
  const state = useRef({ rows, selectedRows, setSelected });
  state.current = { rows, selectedRows, setSelected };
  useEffect(() => {
    const bridge: IssueSelectionBridge = {
      rows: () => state.current.rows,
      selectedKeys: () => state.current.selectedRows.map((r) => r.displayId),
      setSelectedIds: (ids) => state.current.setSelected(ids),
    };
    current = bridge;
    notify();
    return () => {
      if (current === bridge) current = null;
      notify();
    };
  }, []);
  const keys = selectedRows.map((r) => r.displayId).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed selection is the event.
  useEffect(() => notify(), [keys]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The issue keys selected in the Issues list right now; empty where no list is open. */
export function useSelectedIssueKeys(): string {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return current ? current.selectedKeys().join(",") : "";
}
