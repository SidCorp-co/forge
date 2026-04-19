import type { Task, Issue } from "./types";

// Map issue status to the appropriate pipeline skill.
// Statuses not listed here default to forge-code (general coding).
const STATUS_SKILL: Record<string, string> = {
  open: "forge-triage",
  confirmed: "forge-plan",
  approved: "forge-code",
  in_progress: "forge-code",
  testing: "forge-test",
  reopen: "forge-fix",
};

function skillForIssue(issue: Issue): string {
  return STATUS_SKILL[issue.status] || "forge-code";
}

export function buildIssuePrompt(issue: Issue): string {
  const skill = skillForIssue(issue);
  return `/${skill} ${issue.documentId}`;
}

export function buildMultiIssuePrompt(issues: Issue[]): string {
  // Group issues by their pipeline skill so each gets the correct step.
  // e.g. open issues get forge-triage, confirmed get forge-plan, etc.
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    const skill = skillForIssue(issue);
    if (!groups.has(skill)) groups.set(skill, []);
    groups.get(skill)!.push(issue.documentId);
  }
  // If all share the same skill, single line. Otherwise one line per skill group.
  const lines = [...groups.entries()].map(
    ([skill, ids]) => `/${skill} ${ids.join(" ")}`
  );
  return lines.join("\n");
}

export function buildTaskPrompt(task: Task): string {
  const issueId = task.issue?.documentId;
  if (issueId) {
    return `/forge-code ${issueId}\n\nFocus on task: ${task.title} (${task.documentId})`;
  }
  return `Work on task: ${task.title}\n\n${task.description ?? ""}\n\nTask DocumentId: ${task.documentId}`;
}
