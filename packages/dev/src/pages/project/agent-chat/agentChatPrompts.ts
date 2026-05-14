import { buildTaskPrompt } from "@/lib/prompt-builders";
import type { Issue, Task, ProjectConfig } from "@/lib/types";

export function getMcpServersParam(projectConfig: ProjectConfig | undefined) {
  const servers = projectConfig?.mcpServers;
  if (!servers || Object.keys(servers).length === 0) return undefined;
  return servers;
}

// Agent-chat "run on this issue" shortcut. The dev runner is no longer the
// pipeline executor (ISS-115); these chat-initiated prompts default to
// /forge-code so the user can keep coding without picking a stage manually.
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
