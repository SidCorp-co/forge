import type { ShareCreate, ShareCreated, ShareSnapshot } from "@forge/contracts/shares";
import { apiClient } from "@/lib/api/client";

/**
 * Opens a share by its token, which travels in the body and never in a path. A signed-in reader
 * goes through the member door, which also serves a link share; anyone else through the open one.
 */
export function openShare(token: string, signedIn: boolean): Promise<ShareSnapshot> {
  return apiClient<ShareSnapshot>(signedIn ? "/shares/open/member" : "/shares/open", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** Creates a share of one subject of a project; the link comes back once, in `url`. */
export function createShare(projectId: string, body: Pick<ShareCreate, "subjectKind" | "subjectId" | "audience">): Promise<ShareCreated> {
  return apiClient<ShareCreated>(`/projects/${encodeURIComponent(projectId)}/shares`, { method: "POST", body: JSON.stringify(body) });
}
