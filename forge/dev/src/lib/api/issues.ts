import type { Issue, IssueFormData } from "../types";
import { request } from "./client";

// Lightweight fields for issue list views (excludes description, plan, aiSummary, etc.)
const ISSUE_LIST_FIELDS = ["title", "status", "priority", "category", "reportedBy", "agentStatus", "changeHistory", "createdAt", "updatedAt"];
const issueListFieldsQs = ISSUE_LIST_FIELDS.map((f, i) => `fields[${i}]=${f}`).join("&") + "&populate[labels][fields][0]=name&populate[labels][fields][1]=color";

export async function getAllIssues(): Promise<Issue[]> {
  return request(`/issues?${issueListFieldsQs}&sort=updatedAt:desc&pagination[pageSize]=100`);
}

export async function getIssues(
  projectSlug: string,
  status?: string,
): Promise<Issue[]> {
  let path = `/issues?filters[project][slug][$eq]=${encodeURIComponent(projectSlug)}&${issueListFieldsQs}&sort=createdAt:desc&pagination[pageSize]=200`;
  if (status) path += `&filters[status][$eq]=${encodeURIComponent(status)}`;
  return request(path);
}

export async function getIssue(documentId: string): Promise<Issue> {
  return request(`/issues/${documentId}?populate=*`);
}

export async function createIssue(data: IssueFormData): Promise<Issue> {
  return request("/issues", {
    method: "POST",
    body: JSON.stringify({ data }),
  });
}

export async function updateIssue(
  documentId: string,
  data: Partial<Issue>,
): Promise<Issue> {
  return request(`/issues/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
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
  return request(`/issues/${documentId}/cost-summary`);
}
