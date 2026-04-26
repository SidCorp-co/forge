import type { Comment } from "../types";
import { adaptRow, request } from "./client";

function adaptComment(row: Record<string, unknown> & { id: string }): Comment {
  return adaptRow(row) as unknown as Comment;
}

export async function getComments(issueDocId: string): Promise<Comment[]> {
  const rows = await request<Array<Record<string, unknown> & { id: string }>>(
    `/issues/${issueDocId}/comments`,
  );
  return rows.map(adaptComment);
}

export async function createComment(data: { body: string; issue: string; parent?: string }): Promise<Comment> {
  const row = await request<Record<string, unknown> & { id: string }>(
    `/issues/${data.issue}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body: data.body, parent: data.parent }),
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
