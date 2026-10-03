import { apiClient } from "@/lib/api/client";
import type {
  CreateRequirementBody,
  RequirementAction,
  RequirementDetail,
  RequirementList,
} from "./types";

const base = (projectId: string) => `/projects/${projectId}/requirements`;
const one = (projectId: string, req: string) => `${base(projectId)}/${encodeURIComponent(req)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function actionPath(projectId: string, req: string, a: RequirementAction): string {
  if (a.kind === "agree") return `${one(projectId, req)}/agree`;
  return `${one(projectId, req)}/revisions/${a.revision}/${a.kind}`;
}

function actionBody(a: RequirementAction): unknown {
  if (a.kind === "agree") return { revision: a.revision };
  if (a.kind === "return") return { reason: a.reason };
  return {};
}

export const requirementsApi = {
  list: (projectId: string) => apiClient<RequirementList>(base(projectId)),
  get: (projectId: string, req: string) => apiClient<RequirementDetail>(one(projectId, req)),
  create: (projectId: string, body: CreateRequirementBody) =>
    apiClient<RequirementDetail>(base(projectId), post(body)),
  act: (projectId: string, req: string, action: RequirementAction) =>
    apiClient<RequirementDetail>(actionPath(projectId, req, action), post(actionBody(action))),
  /** Opens (or hands back) the viewer's BA assistant room about one requirement (ISS-58). */
  openAssistant: (projectId: string, req: string) =>
    apiClient<{ conversation: { id: string }; reused: boolean }>(`${one(projectId, req)}/assistant`, post({})),
};
