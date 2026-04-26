import type { Issue, IssueFormData } from "../types";
import { adaptRow, request, resolveProjectId } from "./client";

function adaptIssue(row: Record<string, unknown> & { id: string }): Issue {
  // forge/core serializes the human-readable display id as `displayId: "ISS-N"`
  // alongside `issSeq: N`. Map issSeq → legacy `id: number` so existing UI
  // (`ISS-${issue.id}` in IssueListItem) keeps producing real sequence numbers
  // instead of slicing the uuid.
  const adapted = adaptRow(row) as unknown as Issue & { issSeq?: number };
  if (typeof adapted.issSeq === "number") {
    adapted.id = adapted.issSeq as unknown as number;
  }
  return adapted;
}

export async function getAllIssues(): Promise<Issue[]> {
  // TODO(iss-275): forge/core has no global cross-project issues feed; the
  // Dashboard's "all issues" tile renders empty until we either aggregate
  // server-side or fan-out per-project here.
  return [];
}

export async function getIssues(
  projectSlug: string,
  status?: string,
): Promise<Issue[]> {
  const projectId = await resolveProjectId(projectSlug);
  const params = new URLSearchParams({ limit: "200" });
  if (status) params.set("status", status);
  const rows = await request<Array<Record<string, unknown> & { id: string }>>(
    `/projects/${projectId}/issues?${params.toString()}`,
  );
  return rows.map(adaptIssue);
}

export async function getIssue(documentId: string): Promise<Issue> {
  const row = await request<Record<string, unknown> & { id: string }>(`/issues/${documentId}`);
  return adaptIssue(row);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createIssue(
  projectSlugOrId: string,
  data: IssueFormData,
): Promise<Issue> {
  const projectId = UUID_RE.test(projectSlugOrId)
    ? projectSlugOrId
    : await resolveProjectId(projectSlugOrId);
  // forge/core's createSchema is .strict() — only forward fields it accepts.
  // attachments are dropped here until core grows a media surface.
  const body: Record<string, unknown> = {
    title: data.title,
    description: data.description,
    priority: data.priority,
  };
  const row = await request<Record<string, unknown> & { id: string }>(
    `/projects/${projectId}/issues`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return adaptIssue(row);
}

// forge/core's PATCH /issues/:id is .strict() and refuses `status` — status
// changes go through the dedicated transition endpoint. Forward any non-status
// fields via PATCH and dispatch status separately so callers like the board
// drag-handler don't have to know which endpoint to hit.
const ISSUE_TRANSITION_FIELDS = new Set(["status"]);

export async function updateIssue(
  documentId: string,
  data: Partial<Issue>,
): Promise<Issue> {
  const { status, ...rest } = data as Partial<Issue> & { status?: string };

  let latest: Issue | null = null;
  const patchKeys = Object.keys(rest).filter((k) => !ISSUE_TRANSITION_FIELDS.has(k));
  if (patchKeys.length > 0) {
    const row = await request<Record<string, unknown> & { id: string }>(`/issues/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(rest),
    });
    latest = adaptIssue(row);
  }

  if (status) {
    const row = await request<Record<string, unknown> & { id: string }>(
      `/issues/${documentId}/transition`,
      {
        method: "POST",
        body: JSON.stringify({ toStatus: status }),
      },
    );
    latest = adaptIssue(row);
  }

  if (latest) return latest;
  // No-op: caller passed an empty patch; refetch to honor the Promise<Issue> contract.
  return getIssue(documentId);
}

export async function enrichIssue(documentId: string): Promise<void> {
  await request(`/issues/${documentId}/enrich`, { method: "POST" });
}

export interface IssueCostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTurns: number;
  totalCost: number;
  sessionCount: number;
  byStep: { step: string; inputTokens: number; outputTokens: number; cost: number; turns: number; sessionCount: number }[];
  sessions: { documentId: string; title: string; step: string; model: string; cost: number; inputTokens: number; outputTokens: number; turns: number }[];
}

export async function getIssueCostSummary(documentId: string): Promise<IssueCostSummary> {
  // forge/core returns aggregate totals only (estimatedCost, inputTokens, …).
  // Map them onto the legacy Strapi-shape interface so existing UI doesn't
  // break; byStep/sessions stay empty until core exposes that breakdown.
  const r = await request<{
    estimatedCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    requests: number;
    sampleCount: number;
  }>(`/issues/${documentId}/cost-summary`);
  return {
    totalInputTokens: r.inputTokens,
    totalOutputTokens: r.outputTokens,
    totalCacheReadTokens: r.cacheReadTokens,
    totalCacheWriteTokens: r.cacheCreationTokens,
    totalTurns: r.requests,
    totalCost: r.estimatedCost,
    sessionCount: r.sampleCount,
    byStep: [],
    sessions: [],
  };
}
