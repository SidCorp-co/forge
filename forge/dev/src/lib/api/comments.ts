import type { Comment } from "../types";
import { adaptRow, request } from "./client";

function adaptComment(row: Record<string, unknown> & { id: string }): Comment {
  return adaptRow(row) as unknown as Comment;
}

export async function getComments(issueDocId: string): Promise<Comment[]> {
  const rows = await request<Array<Record<string, unknown> & { id: string; createdAt?: string }>>(
    `/issues/${issueDocId}/comments`,
  );
  // core orders desc(createdAt); the dev IssueComments component expects
  // oldest-first, so reverse to ascending order client-side.
  rows.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return rows.map(adaptComment);
}

export async function createComment(data: { body: string; issue: string; parent?: string }): Promise<Comment> {
  // core's commentBodySchema renamed `parent` → `parentId` in ISS-273; forward
  // the new field name when present (older callers still pass `parent`).
  const body: Record<string, unknown> = { body: data.body };
  if (data.parent) body.parentId = data.parent;
  const row = await request<Record<string, unknown> & { id: string }>(
    `/issues/${data.issue}/comments`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return adaptComment(row);
}

export async function updateComment(documentId: string, data: { body: string }): Promise<Comment> {
  const row = await request<Record<string, unknown> & { id: string }>(`/comments/${documentId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return adaptComment(row);
}

export async function deleteComment(documentId: string): Promise<void> {
  return request(`/comments/${documentId}`, { method: "DELETE" });
}
