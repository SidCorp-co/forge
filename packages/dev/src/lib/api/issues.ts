import type { Issue, IssueFormData } from "../types";
import { adaptRow, request, resolveProjectId } from "./client";

function adaptIssue(row: Record<string, unknown> & { id: string }): Issue {
  // packages/core serializes the human-readable display id as `displayId: "ISS-N"`
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
  // TODO(iss-275): packages/core has no global cross-project issues feed; the
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
  const body: Record<string, unknown> = {
    title: data.title,
    description: data.description,
    priority: data.priority,
    ...(data.attachments && data.attachments.length > 0
      ? { attachments: data.attachments }
      : {}),
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

// packages/core's PATCH /issues/:id is .strict() — only the fields below survive.
// Status changes go through the dedicated transition endpoint. updateIssue
// fans the patch out to whichever endpoint owns each field so callers (board
// drag-handler, issue header, attachments panel) don't have to know.
const ISSUE_PATCH_FIELDS = new Set([
  "title",
  "description",
  "priority",
  "category",
  "assigneeId",
  "labels",
]);

export async function updateIssue(
  documentId: string,
  data: Partial<Issue>,
): Promise<Issue> {
  const { status, ...rest } = data as Partial<Issue> & { status?: string };

  // Filter to fields core accepts; warn so silent drops are observable in dev.
  const patchBody: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(rest)) {
    if (ISSUE_PATCH_FIELDS.has(key)) patchBody[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    console.warn(
      `[issues] updateIssue: dropping unsupported field(s) ${dropped.join(", ")} — packages/core's PATCH /issues/:id only accepts ${[...ISSUE_PATCH_FIELDS].join(", ")} (TODO(iss-275)).`,
    );
  }

  // Transition first so a partial failure doesn't leave a PATCH applied without
  // the matching status change. PATCH runs only after a successful transition.
  let latest: Issue | null = null;
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

  if (Object.keys(patchBody).length > 0) {
    const row = await request<Record<string, unknown> & { id: string }>(`/issues/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
    latest = adaptIssue(row);
  }

  if (latest) return latest;
  // No-op: caller passed an empty/all-dropped patch; refetch so we honor Promise<Issue>.
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
  // packages/core returns aggregate totals only (estimatedCost, inputTokens, …).
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
