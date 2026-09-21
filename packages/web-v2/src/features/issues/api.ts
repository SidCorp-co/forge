
import { apiClient, apiClientList } from "@/lib/api/client";
import { filterToQueryParams } from "./derive";
import type {
  CreatedIssue,
  ModuleRollupResponse,
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDetail,
  IssueLabel,
  IssuePriority,
  IssueRow,
  IssueSearchOpts,
  IssueStatus,
  ProjectMember,
  WaitingCause,
} from "./types";

export const ISSUES_PAGE_SIZE = 25;

/** One entry of a `labels` write. A bare string attaches by name or uuid, not primary. */
export type LabelAttach = string | { labelId: string; isPrimary?: boolean };

export interface PatchIssueInput {
  priority?: IssuePriority;
  complexity?: IssueComplexity | null;
  description?: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  priority?: IssuePriority;
  category?: string;
  complexity?: IssueComplexity;
  /** Inline base64 attachments — mirrors core's `issueCreateSchema.attachments`
   *  (max 10, server-validated for size/mime). Omit when none are staged. */
  attachments?: { name: string; mime: string; dataBase64: string }[];
}

/**
 * ISS-949 — the backlog counted by module. `GET /api/projects/:id/modules/rollup`.
 */
export const modulesApi = {
  rollup: (projectId: string, activeWithinDays?: number) => {
    const params = new URLSearchParams();
    if (activeWithinDays !== undefined) params.set("activeWithinDays", String(activeWithinDays));
    const query = params.toString();
    return apiClient<ModuleRollupResponse>(
      `/projects/${projectId}/modules/rollup${query === "" ? "" : `?${query}`}`,
    );
  },
};

export const issuesApi = {
  create: (projectId: string, body: CreateIssueInput) =>
    apiClient<CreatedIssue>(`/projects/${projectId}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  search: (projectId: string, opts: IssueSearchOpts) => {
    const pageSize = opts.pageSize ?? ISSUES_PAGE_SIZE;
    const page = opts.page ?? 1;
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));
    params.set("sort", opts.sort ?? "createdAt:desc");
    params.set("withAgentSessions", "1");
    params.set("withCost", "1");
    params.set("withFailureInfo", "1");
    params.set("withPipelineHealth", "1");
    params.set("withModules", "1");
    params.set("withDependencies", "1");
    params.set("withBuckets", "1");
    if (opts.q) params.set("q", opts.q);
    if (opts.priority) params.set("priority", opts.priority);
    if (opts.createdBy) params.set("createdBy", opts.createdBy);
    if (opts.label) params.set("label", opts.label);
    if (opts.module) params.set("module", opts.module);
    const { status, statusNot, origin } = filterToQueryParams(opts.filter ?? "all");
    for (const s of opts.status ?? status ?? []) params.append("status", s);
    for (const s of statusNot ?? []) params.append("statusNot", s);
    if (origin) params.set("origin", origin);
    return apiClientList<IssueRow, { buckets?: IssueBuckets }>(
      `/projects/${projectId}/issues/search?${params}`,
    );
  },

  /** `PATCH /api/issues/:id` — priority/complexity/description (status is NOT
   *  patchable here; use `transition`). */
  patch: (id: string, body: PatchIssueInput) =>
    apiClient<IssueDetail>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `POST /api/issues/:id/transition` — state-machine guarded status change.
   *  Invalid transitions return 409 (ILLEGAL_TRANSITION). */
  transition: (
    id: string,
    toStatus: IssueStatus,
    opts?: { reason?: string; waitingKind?: WaitingCause },
  ) =>
    apiClient<IssueDetail>(`/issues/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({
        toStatus,
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.waitingKind ? { waitingKind: opts.waitingKind } : {}),
      }),
    }),

  /** `GET /api/issues/:id/cost-summary` — usage rollup for the issue. */
  costSummary: (id: string) => apiClient<IssueCostSummary>(`/issues/${id}/cost-summary`),

  /** `GET /api/issues/:id/dependencies` → `{ outgoing, incoming }` (IDs only). */
  dependencies: (id: string) => apiClient<IssueDependencies>(`/issues/${id}/dependencies`),

  /** `GET /api/projects/:projectId/members` — creator filter option source. */
  members: (projectId: string) => apiClient<ProjectMember[]>(`/projects/${projectId}/members`),

  labels: (projectId: string) => apiClient<IssueLabel[]>(`/projects/${projectId}/labels`),

  setLabels: (id: string, labels: LabelAttach[]) =>
    apiClient<IssueRow>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ labels }),
    }),

  runPipelineStep: (id: string) =>
    apiClient<unknown>(`/issues/${id}/run-pipeline-step`, {
      method: "POST",
      body: "{}",
    }),

  /**
   * `POST /api/issues/:id/merge` — claim that this issue's work shipped, for work finished outside
   * the pipeline. `target` names where it landed and is required; `note` is free text kept on the
   * audit comment the server writes.
   */
  markMerged: (id: string, body: { target: string; note?: string }) =>
    apiClient<{ id: string; action: "merged" | "unmarked" }>(`/issues/${id}/merge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** `DELETE /api/issues/:id/merge` — retract the claim, which re-blocks every `blocks` dependent. */
  unmarkMerged: (id: string, body: { note?: string } = {}) =>
    apiClient<{ id: string; action: "merged" | "unmarked" }>(`/issues/${id}/merge`, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
};

export interface IssueBuckets {
  byStatus: Partial<Record<IssueStatus, number>>;
  detector: number;
  humanDraft: number;
}

/** ISS-764 — batch release API. Separate from issuesApi since these are
 *  project-level endpoints (not per-issue). */
export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: string;
}

/** One issue waiting at the release gate. Mirrors core `ReleaseRosterEntry`. */
export interface ReleaseRosterEntry {
  id: string;
  displayId: string;
  title: string;
  mergedAt: string | null;
  waitingDays: number | null;
  claimedByRunId: string | null;
}

/** What the project's release surface reads. `gateStatus: null` = no gate. */
export interface ReleaseRoster {
  gateStatus: string | null;
  channel: string | null;
  releaseRunnerLabel: string | null;
  baseBranch: string | null;
  nextCutAt: string | null;
  issues: ReleaseRosterEntry[];
}

export const releaseBatchApi = {
  /** `GET /api/projects/:projectId/release-batches/roster` — waiting, oldest first. */
  roster: (projectId: string) =>
    apiClient<ReleaseRoster>(`/projects/${projectId}/release-batches/roster`),

  /** `POST /api/projects/:projectId/release-batches` — create + claim a batch. */
  create: (projectId: string, issueIds: string[]) =>
    apiClient<CreateReleaseBatchResult>(
      `/projects/${projectId}/release-batches`,
      {
        method: "POST",
        body: JSON.stringify({ issueIds }),
      },
    ),
};
