import type { ItemStanding, StewardNote, StewardNoteSubjectKind } from "@forge/contracts/steward";
import { apiClient } from "@/lib/api/client";

export const standingApi = {
  /** Every open item's standing, stuck first, with its current steward note (REQ-48 BC-8). */
  standings: (projectId: string) => apiClient<{ standings: ItemStanding[] }>(`/projects/${projectId}/standings`),
  /** One requirement's or feedback item's current steward note, or null where none is written. */
  note: (projectId: string, kind: StewardNoteSubjectKind, key: string) =>
    apiClient<{ note: StewardNote | null }>(`/projects/${projectId}/steward-notes/${kind}/${encodeURIComponent(key)}`),
};
