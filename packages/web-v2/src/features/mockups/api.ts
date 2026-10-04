import { apiClient } from "@/lib/api/client";
import { coreFileUrl } from "@/lib/utils/core-url";
import type { MockupListResponse, MockupResponse, MockupTarget, ProposeMockupRequest } from "./types";

const base = (projectId: string) => `/projects/${projectId}/mockups`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const mockupsApi = {
  list: (projectId: string, target: MockupTarget) =>
    apiClient<MockupListResponse>(`${base(projectId)}?${target.type}=${encodeURIComponent(target.key)}`),
  propose: (projectId: string, body: ProposeMockupRequest) => apiClient<MockupResponse>(base(projectId), post(body)),
  act: (projectId: string, key: string, act: "accept" | "return" | "withdraw", reason?: string) =>
    apiClient<MockupResponse>(`${base(projectId)}/${encodeURIComponent(key)}/${act}`, post(act === "withdraw" || !reason ? {} : { reason })),
  /** The bytes, through the session cookie: the content route serves every mockup inert. */
  bytes: async (url: string): Promise<Blob> => {
    const res = await fetch(coreFileUrl(url), { credentials: "include" });
    if (!res.ok) throw new Error(`the mockup could not be read (${res.status})`);
    return res.blob();
  },
};

export function targetInput(t: MockupTarget): ProposeMockupRequest["target"] {
  if (t.type === "requirement") return { requirement: t.key, revision: t.revision };
  return t.type === "feedback" ? { feedback: t.key } : { issue: t.key };
}

export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
