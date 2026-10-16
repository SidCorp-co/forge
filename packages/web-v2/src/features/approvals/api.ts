import { apiClient } from "@/lib/api/client";
import type { ApprovalAct, ApprovalInbox } from "./types";

/** An act's filled path is a core route (`/api/...`); the client adds that prefix itself. */
const endpointOf = (path: string) => (path.startsWith("/api/") ? path.slice("/api".length) : path);

export const approvalsApi = {
  read: (projectId: string) => apiClient<ApprovalInbox>(`/projects/${projectId}/approvals`),
  /** Press one row's act: its own body, with the reason typed where the act takes one, as the signed-in person. */
  press: (act: ApprovalAct, reason: string | undefined) =>
    apiClient<unknown>(endpointOf(act.path), {
      method: "POST",
      body: JSON.stringify({ ...(act.body ?? {}), ...(act.reason !== "none" && reason ? { reason } : {}) }),
    }),
};
