import type { Task } from "./types";

export function buildTaskPrompt(task: Task): string {
  const issueId = task.issue?.documentId;
  if (issueId) {
    return `/forge-code ${issueId}\n\nFocus on task: ${task.title} (${task.documentId})`;
  }
  return `Work on task: ${task.title}\n\n${task.description ?? ""}\n\nTask DocumentId: ${task.documentId}`;
}
