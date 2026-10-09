import type { DecisionMaker } from "@forge/contracts/comments";
import type { RequirementKind, WritePictureRequest } from "@forge/contracts/requirement-pictures";
import type { PromoteDraftsAnswer, RequirementDecisionsResponse } from "@forge/contracts/requirements";
import { apiClient } from "@/lib/api/client";
import type {
  CreateRequirementBody,
  RequirementAction,
  RequirementAreaRef,
  RequirementDetail,
  RequirementList,
  RequirementSpec,
} from "./types";

const base = (projectId: string) => `/projects/${projectId}/requirements`;
const one = (projectId: string, req: string) => `${base(projectId)}/${encodeURIComponent(req)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

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

const areasPath = (projectId: string) => `/projects/${projectId}/requirement-areas`;

export const requirementsApi = {
  areas: (projectId: string) => apiClient<{ areas: RequirementAreaRef[] }>(areasPath(projectId)),
  setAreas: (projectId: string, names: string[]) => apiClient<{ areas: RequirementAreaRef[] }>(areasPath(projectId), put({ names })),
  /** Asks the assistant for an area and short name for every requirement that has none; they arrive as proposals. */
  proposePlacements: (projectId: string) => apiClient<{ asked: number }>(`${areasPath(projectId)}/propose`, post({})),
  setPlacement: (projectId: string, req: string, body: { areaId?: string | null; shortName?: string | null }) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/placement`, put(body)),
  acceptPlacement: (projectId: string, req: string) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/placement/accept`, post({})),
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
  /** Sets or corrects a revision's kind (REQ-35); null clears it, and a picture drawn for another kind leaves with it. */
  writeKind: (projectId: string, req: string, revision: number, kind: RequirementKind | null) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/revisions/${revision}/kind`, put({ kind })),
  /** Draws or replaces a revision's one picture, shown at once with no accept (REQ-35). */
  writePicture: (projectId: string, req: string, revision: number, body: WritePictureRequest) =>
    apiClient<RequirementDetail>(`${one(projectId, req)}/revisions/${revision}/picture`, put(body)),
  /** Rewrites a draft revision whole: its summary and one criterion per line; the spec it holds is kept. */
  writeDraft: (
    projectId: string,
    req: string,
    revision: { revision: number; spec: RequirementSpec; tldr: string | null; criteria: { code: string; body: string; form: string }[] },
    write: { tldr: string; criteria: string[] },
  ) =>
    apiClient<RequirementDetail>(
      `${one(projectId, req)}/revisions/${revision.revision}`,
      put({
        reason: "Written on the draft",
        spec: revision.spec,
        tldr: write.tldr,
        criteria: write.criteria.map((body) => {
          const held = revision.criteria.find((c) => c.body === body);
          return held ? { code: held.code, body } : { body };
        }),
      }),
    ),
  /** Opens (or hands back) the viewer's BA assistant room about one requirement (ISS-58). */
  openAssistant: (projectId: string, req: string) =>
    apiClient<{ conversation: { id: string }; reused: boolean }>(`${one(projectId, req)}/assistant`, post({})),
};
