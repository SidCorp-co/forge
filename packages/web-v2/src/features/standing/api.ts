import type { ItemStanding, StewardNote, StewardNoteSubjectKind } from "@forge/contracts/steward";
import type { StewardActsResponse, StewardBudgetView, StewardUndoResponse } from "@forge/contracts/steward-runtime";
import { apiClient } from "@/lib/api/client";

export const standingApi = {
  /** Every open item's standing, stuck first, with its current steward note (REQ-48 BC-8). */
  standings: (projectId: string) => apiClient<{ standings: ItemStanding[] }>(`/projects/${projectId}/standings`),
  /** One requirement's or feedback item's current steward note, or null where none is written. */
  note: (projectId: string, kind: StewardNoteSubjectKind, key: string) =>
    apiClient<{ note: StewardNote | null }>(`/projects/${projectId}/steward-notes/${kind}/${encodeURIComponent(key)}`),
  /** Every act the steward took on one item, newest first, whichever run took it (REQ-48 BC-12). */
  acts: (projectId: string, key: string) => apiClient<StewardActsResponse>(`/projects/${projectId}/steward-acts?subject=${encodeURIComponent(key)}`),
  /** The steward's UTC day on the project: each share, what it spent, and whether it is quiet. */
  budget: (projectId: string) => apiClient<StewardBudgetView>(`/projects/${projectId}/steward-budget`),
  /** Undo one act through the inverse door its record names; core refuses one with none by name. */
  undo: (projectId: string, actId: string) => apiClient<StewardUndoResponse>(`/projects/${projectId}/steward-acts/${actId}/undo`, { method: "POST" }),
};
