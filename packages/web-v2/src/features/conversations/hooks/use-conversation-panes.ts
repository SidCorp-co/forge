"use client";

// Desktop multi-pane state for Conversations (ISS-689). Persisted per-tab
// (localStorage, not URL — panes are a personal working set, not a shareable
// view) so a reload restores the open panes instead of losing them. The
// list-transform logic is factored into pure functions (below) so it's
// unit-testable without a DOM (this package's vitest config is `node`-only).
import { useCallback, useMemo } from "react";
import { usePersistedState } from "@/lib/utils/use-persisted-state";

export interface PaneEntry {
  sessionId: string;
  projectId: string;
  width: number;
}

/** Each pane is a live agent session with its own WS room + possible running
 *  turn — 4 keeps a 1440px desktop at >=360px/pane (MIN_PANE_WIDTH) before
 *  scroll, bounds runner fan-out, and keeps the "waiting for me" scan legible. */
export const PANE_CAP = 4;
export const DEFAULT_PANE_WIDTH = 420;
export const MIN_PANE_WIDTH = 360;
export const MAX_PANE_WIDTH = 760;

const STORAGE_KEY = "web-v2:conversation-panes";

export type AddPaneResult = "added" | "exists" | "cap";

export function clampPaneWidth(width: number): number {
  return Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, width));
}

/** Append a pane, deduping by sessionId and rejecting past `PANE_CAP`. Pure —
 *  returns the (possibly unchanged) list plus which case applied. */
export function addPaneEntry(
  panes: PaneEntry[],
  entry: { sessionId: string; projectId: string },
): { panes: PaneEntry[]; result: AddPaneResult } {
  if (panes.some((p) => p.sessionId === entry.sessionId)) {
    return { panes, result: "exists" };
  }
  if (panes.length >= PANE_CAP) {
    return { panes, result: "cap" };
  }
  return {
    panes: [...panes, { sessionId: entry.sessionId, projectId: entry.projectId, width: DEFAULT_PANE_WIDTH }],
    result: "added",
  };
}

export function removePaneEntry(panes: PaneEntry[], sessionId: string): PaneEntry[] {
  return panes.filter((p) => p.sessionId !== sessionId);
}

export function resizePaneEntry(panes: PaneEntry[], sessionId: string, width: number): PaneEntry[] {
  const clamped = clampPaneWidth(width);
  return panes.map((p) => (p.sessionId === sessionId ? { ...p, width: clamped } : p));
}

export interface UseConversationPanes {
  panes: PaneEntry[];
  atCap: boolean;
  isOpen: (sessionId: string) => boolean;
  addPane: (entry: { sessionId: string; projectId: string }) => AddPaneResult;
  removePane: (sessionId: string) => void;
  resizePane: (sessionId: string, width: number) => void;
}

export function useConversationPanes(): UseConversationPanes {
  const [panes, setPanes] = usePersistedState<PaneEntry[]>(STORAGE_KEY, [], {
    syncTabs: false,
  });

  const openIds = useMemo(() => new Set(panes.map((p) => p.sessionId)), [panes]);
  const isOpen = useCallback((sessionId: string) => openIds.has(sessionId), [openIds]);

  const addPane = useCallback(
    ({ sessionId, projectId }: { sessionId: string; projectId: string }): AddPaneResult => {
      // Decide off the current render's state (not inside the setState
      // updater) so the result is available synchronously to the caller —
      // React may defer running a functional updater past this call.
      const { result } = addPaneEntry(panes, { sessionId, projectId });
      if (result === "added") setPanes((prev) => addPaneEntry(prev, { sessionId, projectId }).panes);
      return result;
    },
    [panes, setPanes],
  );

  const removePane = useCallback(
    (sessionId: string) => setPanes((prev) => removePaneEntry(prev, sessionId)),
    [setPanes],
  );

  const resizePane = useCallback(
    (sessionId: string, width: number) => setPanes((prev) => resizePaneEntry(prev, sessionId, width)),
    [setPanes],
  );

  return { panes, atCap: panes.length >= PANE_CAP, isOpen, addPane, removePane, resizePane };
}
