
import { parseReleaseRoster } from "@/features/releases/roster";
import { apiClient, apiClientList } from "@/lib/api/client";
import type { WorkState } from "@forge/contracts/work-state";
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

/** What `POST /api/issues/:id/transition` answers. */
export interface TransitionAnswer {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  transitionedAt: string;
  rewritten: {
    requested: IssueStatus;
    stored: IssueStatus;
    rule: "autonomous_driver" | "release_gate";
    waitingKind: { sent: WaitingCause | null; stored: WaitingCause | null };
    detail: string;
  } | null;
  warnings?: string[];
}

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
    const { workState } = filterToQueryParams(opts.filter ?? "all");
    if (workState) params.set("workState", workState);
    for (const s of opts.status ?? []) params.append("status", s);
    if (opts.origin) params.set("origin", opts.origin);
    return apiClientList<IssueRow, { buckets?: IssueBuckets }>(
      `/projects/${projectId}/issues/search?${params}`,
    );
  },

  /** The search route at five rows and none of the list's hydration: what the ⌘K box asks per term. */
  lookup: (projectId: string, q: string) =>
    apiClientList<Pick<IssueRow, "id" | "displayId" | "title">>(
      `/projects/${projectId}/issues/search?${new URLSearchParams({ q, limit: "5" })}`,
    ),

  /** `PATCH /api/issues/:id` — priority/complexity/description (status is NOT
   *  patchable here; use `transition`). */
  patch: (id: string, body: PatchIssueInput) =>
    apiClient<IssueDetail>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `POST /api/issues/:id/transition` — state-machine guarded status change.
   *  Invalid transitions return 409 (ILLEGAL_TRANSITION). `status` is what was stored, which
   *  `rewritten` names where a rule stored something other than `toStatus`. */
  transition: (
    id: string,
    toStatus: IssueStatus,
    opts?: { reason?: string; waitingKind?: WaitingCause; voidQuestions?: string },
  ) =>
    apiClient<TransitionAnswer>(`/issues/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({
        toStatus,
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.waitingKind ? { waitingKind: opts.waitingKind } : {}),
        ...(opts?.voidQuestions !== undefined ? { voidQuestions: opts.voidQuestions } : {}),
      }),
    }),

  /** `GET /api/issues/:id/cost-summary` — usage rollup for the issue. `id` is
   *  the display key as often as the row uuid (ISS-1160); `projectId` is what
   *  lets a key resolve. */
  costSummary: (id: string, projectId?: string) =>
    apiClient<IssueCostSummary>(
      `/issues/${id}/cost-summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),

  /** `GET /api/issues/:id/dependencies` → `{ outgoing, incoming }` (IDs only). */
  dependencies: (id: string, projectId?: string) =>
    apiClient<IssueDependencies>(
      `/issues/${id}/dependencies${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),

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
   * the pipeline. `target` is the audit label and is required; `landing` is where the work landed
   * outside git, which an issue whose `landingShape` is `outside_git` must send; `note` is free
   * text kept on the audit comment the server writes.
   */
  markMerged: (id: string, body: MarkMergedBody) =>
    apiClient<MarkMergedAnswer>(`/issues/${id}/merge`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** `DELETE /api/issues/:id/merge` — withdraw the claim. It re-blocks nothing: `blocks`
   * dependents are held by the issue's STATUS and not by this column (ISS-1100). */
  unmarkMerged: (id: string, body: { note?: string } = {}) =>
    apiClient<{ id: string; action: "merged" | "unmarked" }>(`/issues/${id}/merge`, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
};

export interface IssueBuckets {
  byStatus: Partial<Record<IssueStatus, number>>;
  /** Issues in each work state under every filter but the work state: they add up to the list's total with no state chosen. */
  byWorkState: Record<WorkState, number>;
}

/** ISS-764 — batch release API. Separate from issuesApi since these are
 *  project-level endpoints (not per-issue). */
export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: string;
  verification: "probed" | "unverified";
  /** The cut this release promotes and each off-roster issue its range carries (ISS-1386). */
  carried: CreatedCarried | null;
  warnings: { code: string; message: string }[];
}

export interface CreatedCarriedIssue {
  issueId: string;
  displayId: string;
  status: string;
  landing: string;
  decision: CarriedDecisionBody["decision"];
  why?: string;
}

export type CreatedCarried =
  | { kind: "not-read" | "unbound" | "unread"; why: string }
  | {
      kind: "read";
      live: string;
      start: string;
      cut: string;
      issues: CreatedCarriedIssue[];
      cutBelow: CreatedCarriedIssue[];
    };

export type { ReleaseRoster, ReleaseRosterEntry } from "@/features/releases/roster";

export type CarriedDecisionBody =
  | { issueId: string; decision: "ship-unverified"; why: string }
  | { issueId: string; decision: "revert" | "cut-below" };

export const releaseBatchApi = {
  /** `GET …/release-batches/roster` — waiting, oldest first. Parsed, not cast. */
  roster: async (projectId: string) => {
    const endpoint = `/projects/${projectId}/release-batches/roster`;
    return parseReleaseRoster(await apiClient<unknown>(endpoint), endpoint);
  },

  /** `POST /api/projects/:projectId/release-batches` — create + claim a batch (ISS-1386 `carried`). */
  create: (projectId: string, issueIds: string[], carried?: CarriedDecisionBody[]) =>
    apiClient<CreateReleaseBatchResult>(
      `/projects/${projectId}/release-batches`,
      {
        method: "POST",
        body: JSON.stringify(carried && carried.length > 0 ? { issueIds, carried } : { issueIds }),
      },
    ),
};

/** `already_merged` moved nothing: the mark that stands was kept (ISS-1327). */
export interface MarkMergedAnswer {
  id: string;
  action: "merged" | "already_merged";
  mark?: string;
  detail?: string;
}

export interface MarkMergedBody {
  target?: string;
  landing?: string;
  note?: string;
}
