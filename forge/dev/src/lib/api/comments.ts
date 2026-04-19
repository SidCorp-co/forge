import type { Comment } from "../types";
import { request } from "./client";

export async function getComments(issueDocId: string): Promise<Comment[]> {
  return request(`/comments?filters[issue][documentId][$eq]=${encodeURIComponent(issueDocId)}&populate=*&sort=createdAt:asc`);
}

export async function createComment(data: { body: string; issue: string; parent?: string }): Promise<Comment> {
  return request("/comments", {
    method: "POST",
    body: JSON.stringify({ data }),
  });
}

export async function updateComment(documentId: string, data: { body: string }): Promise<Comment> {
  return request(`/comments/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}

export async function deleteComment(documentId: string): Promise<void> {
  return request(`/comments/${documentId}`, { method: "DELETE" });
}
