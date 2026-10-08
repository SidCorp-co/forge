import type { DecisionMaker } from "@forge/contracts/comments";
import type { PromoteDraftsAnswer, RequirementDecisionsResponse } from "@forge/contracts/requirements";
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
  if (a.kind === "accept-delivery") return `${one(projectId, req)}/accept`;
  if (a.kind === "drop") return `${one(projectId, req)}/drop`;
  if (a.kind === "agree" || a.kind === "repin" || a.kind === "defer" || a.kind === "undefer") return `${one(projectId, req)}/${a.kind}`;
  return `${one(projectId, req)}/revisions/${a.revision}/${a.kind}`;
}

const given = (reason: string | undefined) => (reason ? { reason } : {});

function actionBody(a: RequirementAction): unknown {
  if (a.kind === "agree" || a.kind === "repin" || a.kind === "accept-delivery") return { revision: a.revision, ...given(a.reason) };
  if (a.kind === "accept") return given(a.reason);
  if (a.kind === "drop") return { reason: a.reason };
  if (a.kind === "return") return { reason: a.reason };
  if (a.kind === "defer") return { reason: a.reason, ...(a.targetPhase ? { targetPhase: a.targetPhase } : {}) };
  if (a.kind === "undefer") return { reason: a.reason };
  return {};
}

export const requirementsApi = {
  list: (projectId: string) => apiClient<RequirementList>(base(projectId)),
  get: (projectId: string, req: string) => apiClient<RequirementDetail>(one(projectId, req)),
  create: (projectId: string, body: CreateRequirementBody) =>
    apiClient<RequirementDetail>(base(projectId), post(body)),
  act: (projectId: string, req: string, action: RequirementAction) =>
    apiClient<RequirementDetail>(actionPath(projectId, req, action), post(actionBody(action))),
  /** Promotes the named draft issues to open, or every linked draft when none is named (FB-93). */
  promoteDrafts: (projectId: string, req: string, issues?: string[]) =>
    apiClient<PromoteDraftsAnswer>(`${one(projectId, req)}/promote`, post(issues ? { issues } : {})),
  /** Its decisions and those on its issues, with the answers its questions and its issues' questions took. */
  decisions: (projectId: string, req: string, by: DecisionMaker = "people") =>
    apiClient<RequirementDecisionsResponse>(`${one(projectId, req)}/decisions${by === "people" ? "" : `?by=${by}`}`),
  /** Links an existing issue as one that delivers it; `adoptPlan` records the issue's plan as written against the current revision. */
  linkIssue: (projectId: string, req: string, issue: string, adoptPlan: boolean) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/issues`, post({ issue, ...(adoptPlan ? { adoptPlan: true } : {}) })),
  unlinkIssue: (projectId: string, req: string, issue: string) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/issues/${encodeURIComponent(issue)}`, { method: "DELETE" }),
  /** Opens (or hands back) the viewer's BA assistant room about one requirement (ISS-58). */
  openAssistant: (projectId: string, req: string) =>
    apiClient<{ conversation: { id: string }; reused: boolean }>(`${one(projectId, req)}/assistant`, post({})),
};
