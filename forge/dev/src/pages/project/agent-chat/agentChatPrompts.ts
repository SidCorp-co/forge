import { buildTaskPrompt, buildIssuePrompt, buildMultiIssuePrompt } from "@/lib/prompt-builders";
import type { Issue, Task, ProjectConfig } from "@/lib/types";

export function getMcpServersParam(projectConfig: ProjectConfig | undefined) {
  const servers = projectConfig?.mcpServers;
  if (!servers || Object.keys(servers).length === 0) return undefined;
  return servers;
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
  if (multiIssues.length > 0) return buildMultiIssuePrompt(multiIssues);
  if (issue) return buildIssuePrompt(issue);
  return null;
}
