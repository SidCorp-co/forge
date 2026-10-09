import { apiClient } from "@/lib/api/client";
import type { IntakeDraftResponse } from "./types";

export const intakeApi = {
  /** The intake assistant's draft of one requirement (REQ-n) or feedback item (FB-n), or null while none was made. */
  draft: (projectId: string, ref: string) =>
    apiClient<IntakeDraftResponse>(`/projects/${projectId}/intake-drafts/${encodeURIComponent(ref)}`),
};
