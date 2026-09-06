// web-v2 feature module: issues — REST surface. Every call goes through the
// shared `apiClient`/`apiClientList` (no raw fetch). Paths verified against
// core: `issues/search.ts`, `issues/routes.ts` (PATCH), `issues/transition.ts`,
// `issues/extras-routes.ts` (cost-summary, run-pipeline-step),
// `issues/dependency-routes.ts`, `projects/members-routes.ts`.

import { apiClient, apiClientList } from "@/lib/api/client";
import { filterToQueryParams } from "./derive";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
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
// cm:edge contract -> packages/core/src/issues/label-service.ts#LabelAttachInput — the union arms and their meaning are that type's; `isPrimary` on a plain label is refused with PRIMARY_NOT_MODULE
export type LabelAttach = string | { labelId: string; isPrimary?: boolean };

export interface PatchIssueInput {
  priority?: IssuePriority;
  complexity?: IssueComplexity | null;
}

/** Body for `POST /api/projects/:id/issues`. Mirrors the core
 *  `issueCreateSchema` allow-list — `title` is required; the rest optional.
 *  `status` is intentionally omitted (new issues enter the pipeline at `open`,
 *  the server default). */
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

export const issuesApi = {
  /** `POST /api/projects/:id/issues` — create an issue (caller must be a
   *  project member). Returns the created row incl. `displayId` (`ISS-<seq>`)
   *  for navigation to its detail page. */
  create: (projectId: string, body: CreateIssueInput) =>
    apiClient<IssueRow>(`/projects/${projectId}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
    // cm:why one grouped query on this response replaced a per-row cost-summary N+1 (ISS-437) — dropping the flag brings the N+1 back rather than losing a column
    params.set("withCost", "1");
    // ISS-700 — same grouped-query pattern for the latest-failed-job info
    // backing the Failed-badge tooltip (no per-row/hover fetch).
    params.set("withFailureInfo", "1");
    // cm:why carries the queued step + its gate, without which a queued-but-undispatched row renders as actively worked
    params.set("withPipelineHealth", "1");
    // cm:why ISS-594 — the row's module attributions, and the only source for the list's Module cell: the search response carries no labels otherwise
    params.set("withModules", "1");
    if (opts.q) params.set("q", opts.q);
    if (opts.priority) params.set("priority", opts.priority);
    if (opts.createdBy) params.set("createdBy", opts.createdBy);
    if (opts.label) params.set("label", opts.label);
    // cm:why ISS-594 — a SEPARATE param from `label`: core resolves `module` against `kind='module'` rows only, so sending a module id as `label` would match plain labels of the same name
    if (opts.module) params.set("module", opts.module);
    const { status, statusNot, origin } = filterToQueryParams(opts.filter ?? "all");
    for (const s of status ?? []) params.append("status", s);
    for (const s of statusNot ?? []) params.append("statusNot", s);
    if (origin) params.set("origin", origin);
    return apiClientList<IssueRow>(`/projects/${projectId}/issues/search?${params}`);
  },

  /** `PATCH /api/issues/:id` — priority/complexity (status is NOT patchable
   *  here; use `transition`). */
  patch: (id: string, body: PatchIssueInput) =>
    apiClient<IssueRow>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `POST /api/issues/:id/transition` — state-machine guarded status change.
   *  Invalid transitions return 409 (ILLEGAL_TRANSITION). */
  // cm:guard `reason` is REQUIRED entering reopen / waiting / needs_info, and `waitingKind` additionally for waiting (RFC 0002 INV-8) — the server answers 422 without them, so a caller that cannot collect one must not offer the action
  transition: (
    id: string,
    toStatus: IssueStatus,
    opts?: { reason?: string; waitingKind?: WaitingCause },
  ) =>
    apiClient<IssueRow>(`/issues/${id}/transition`, {
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

  /** `GET /api/projects/:projectId/labels` — label filter option source (ISS-586). */
  labels: (projectId: string) => apiClient<IssueLabel[]>(`/projects/${projectId}/labels`),

  /**
   * `PATCH /api/issues/:id` — REPLACE the issue's whole label set.
   *
   * `labels` is a full replacement, not a delta: every label the issue keeps must be resent, and
   * `[]` clears them all. The object form designates the primary module; a bare string attaches a
   * label as non-primary.
   */
  // cm:guard the caller must merge the issue's existing non-module labels into `labels` — sending only the modules DELETES every plain label on the issue, and the server cannot tell that from a deliberate clear
  setLabels: (id: string, labels: LabelAttach[]) =>
    apiClient<IssueRow>(`/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ labels }),
    }),

  /** `POST /api/issues/:id/run-pipeline-step` — hand the issue to the driver
   *  (409 if a job is already active, or if it is not at the entry status).
   *  Takes no body: there is one lane and one step to run. */
  runPipelineStep: (id: string) =>
    apiClient<unknown>(`/issues/${id}/run-pipeline-step`, {
      method: "POST",
      body: "{}",
    }),
};

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
// cm:edge contract -> packages/core/src/release-batch/queries.ts — serialized straight onto this shape; a field renamed there and not here arrives as `undefined` and renders as a blank cell rather than an error
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
