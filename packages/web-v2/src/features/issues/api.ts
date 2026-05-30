// web-v2 feature module: issues — REST surface. Every call goes through the
// shared `apiClient`/`apiClientList` (no raw fetch). Paths verified against
// core: `issues/search.ts`, `issues/routes.ts` (PATCH), `issues/transition.ts`,
// `issues/extras-routes.ts` (cost-summary, run-pipeline-step, manual-hold),
// `issues/dependency-routes.ts`, `projects/members-routes.ts`.

import { apiClient, apiClientList } from "@/lib/api/client";
import { filterToStatusParams } from "./derive";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssuePriority,
  IssueRow,
  IssueSearchOpts,
  IssueStatus,
  ProjectMember,
} from "./types";

export const ISSUES_PAGE_SIZE = 25;

export interface PatchIssueInput {
  priority?: IssuePriority;
  complexity?: IssueComplexity | null;
  assigneeId?: string | null;
}

export const issuesApi = {
  /**
   * `GET /api/projects/:id/issues/search` — server-side search + filters +
   * sort + pagination, hydrating `agentSessions`/`agentStatus`. Returns flat
   * rows + `X-Total-Count`.
   */
  search: (projectId: string, opts: IssueSearchOpts) => {
    const pageSize = opts.pageSize ?? ISSUES_PAGE_SIZE;
    const page = opts.page ?? 1;
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    params.set("sort", opts.sort ?? "createdAt:desc");
    params.set("withAgentSessions", "1");
    if (opts.q) params.set("q", opts.q);
    const { status, statusNot } = filterToStatusParams(opts.filter ?? "all");
    for (const s of status ?? []) params.append("status", s);
    for (const s of statusNot ?? []) params.append("statusNot", s);
    return apiClientList<IssueRow>(`/projects/${projectId}/issues/search?${params}`);
  },

  /** `PATCH /api/issues/:id` — priority/complexity/assignee (status is NOT
   *  patchable here; use `transition`). */
  patch: (id: string, body: PatchIssueInput) =>
    apiClient<IssueRow>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `POST /api/issues/:id/transition` — state-machine guarded status change.
   *  Invalid transitions return 409 (ILLEGAL_TRANSITION). */
  transition: (id: string, toStatus: IssueStatus, reason?: string) =>
    apiClient<IssueRow>(`/issues/${id}/transition`, {
      method: "POST",
      body: JSON.stringify(reason ? { toStatus, reason } : { toStatus }),
    }),

  /** `GET /api/issues/:id/cost-summary` — usage rollup for the issue. */
  costSummary: (id: string) => apiClient<IssueCostSummary>(`/issues/${id}/cost-summary`),

  /** `GET /api/issues/:id/dependencies` → `{ outgoing, incoming }` (IDs only). */
  dependencies: (id: string) => apiClient<IssueDependencies>(`/issues/${id}/dependencies`),

  /** `GET /api/projects/:projectId/members` — assignee option source. */
  members: (projectId: string) => apiClient<ProjectMember[]>(`/projects/${projectId}/members`),

  /** `POST /api/issues/:id/run-pipeline-step` — kick the pipeline (409 if a job
   *  is already active). `stage` optional. */
  runPipelineStep: (id: string, stage?: string) =>
    apiClient<unknown>(`/issues/${id}/run-pipeline-step`, {
      method: "POST",
      body: JSON.stringify(stage ? { stage } : {}),
    }),
};
