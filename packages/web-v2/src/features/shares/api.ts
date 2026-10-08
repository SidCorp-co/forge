import type {
  ShareAudienceOption,
  ShareCreate,
  ShareCreated,
  ShareLinkView,
  ShareSnapshot,
} from "@forge/contracts/shares";
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

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/shares`;

export const sharesApi = {
  /** A project's shares, newest first. A list row never holds a token or its hash. */
  list: (projectId: string) =>
    apiClient<{ shares: ShareLinkView[] }>(base(projectId)).then((r) => r.shares),
  /** Each audience, open or refused as creating a share for it would be, read by core. */
  audiences: (projectId: string) =>
    apiClient<{ audiences: ShareAudienceOption[] }>(`${base(projectId)}/audiences`).then(
      (r) => r.audiences,
    ),
  /** Creates a share; the answer carries its link, the one time it is shown. */
  create: (projectId: string, body: ShareCreate) =>
    apiClient<ShareCreated>(base(projectId), { method: "POST", body: JSON.stringify(body) }),
  revoke: (projectId: string, shareId: string) =>
    apiClient<{ share: ShareLinkView }>(
      `${base(projectId)}/${encodeURIComponent(shareId)}/revoke`,
      { method: "POST" },
    ).then((r) => r.share),
};
