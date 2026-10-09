import type { NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { apiClient } from "@/lib/api/client";
import type { NeedsYouResponse } from "./types";

/** A decision's filled path is a core route (`/api/...`); the client adds that prefix itself. */
const endpointOf = (path: string) => (path.startsWith("/api/") ? path.slice("/api".length) : path);

export const needsYouApi = {
  read: (projectId: string) => apiClient<NeedsYouResponse>(`/projects/${projectId}/needs-you`),
  decisions: (projectId: string) => apiClient<NeedsYouDecisions>(`/projects/${projectId}/needs-you/decisions`),
  /** Press one decision's button: its body to its filled path, as the signed-in person. */
  press: (path: string, body: Record<string, unknown>) =>
    apiClient<unknown>(endpointOf(path), { method: "POST", body: JSON.stringify(body) }),
};
