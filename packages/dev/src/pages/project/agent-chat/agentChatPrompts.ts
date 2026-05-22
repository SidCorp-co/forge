import type { Issue, Task, ProjectConfig } from "@/lib/types";

/**
 * Chat-initiated skill invocations. These are intentionally trivial template
 * strings — the COMPLEX prompt building (system preamble, issueSnapshot,
 * sessionContext) lives server-side in `@forge/core` under `src/prompt/`.
 * Pipeline jobs build through that SSOT and forward the resulting prompt to
 * the runner; chat "run on this issue" shortcuts only need the skill
 * invocation here because the skill itself fetches data via MCP.
 */

export function getMcpServersParam(projectConfig: ProjectConfig | undefined) {
  const servers = projectConfig?.mcpServers;
  if (!servers || Object.keys(servers).length === 0) return undefined;
  return servers;
}

function buildTaskPrompt(task: Task): string {
  const issueId = task.issue?.documentId;
  if (issueId) {
    return `/forge-code ${issueId}\n\nFocus on task: ${task.title} (${task.documentId})`;
  }
  return `Work on task: ${task.title}\n\n${task.description ?? ""}\n\nTask DocumentId: ${task.documentId}`;
}

function buildAgentChatIssuePrompt(issue: Issue): string {
  return `/forge-code ${issue.documentId}`;
}

function buildAgentChatMultiIssuePrompt(issues: Issue[]): string {
  return `/forge-code ${issues.map((i) => i.documentId).join(" ")}`;
}

export function getActivePrompt(
  confirmed: boolean,
  promptDraft: string | null,
  task: Task | undefined,
  issue: Issue | undefined,
  multiIssues: Issue[],
): string | null {
  if (confirmed && promptDraft) return promptDraft;
  if (task) return buildTaskPrompt(task);
  if (multiIssues.length > 0) return buildAgentChatMultiIssuePrompt(multiIssues);
  if (issue) return buildAgentChatIssuePrompt(issue);
  return null;
}
