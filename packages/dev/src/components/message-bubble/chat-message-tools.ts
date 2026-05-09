import type { ToolCall } from "@/lib/types";

export const MAX_TOOL_OUTPUT = 2000;
export const EXPAND_BY_DEFAULT = new Set(["Edit", "Write"]);

function formatMcpLabel(name: string, input: Record<string, unknown>): string {
  const toolName = name.replace(/^mcp__[^_]+__/, "");
  const action = (input.action as string) ?? "";
  const id = (input.uuid as string) ?? (input.documentId as string) ?? "";
  const detail = id ? `(${id})` : action ? `(${action})` : "";

  switch (toolName) {
    case "forge_coolify_deploy": return `Deploy${detail}`;
    case "forge_issues": {
      if (action === "get" || action === "update") return `Issue${id ? `(${id.slice(0, 8)})` : `(${action})`}`;
      return `Issues(${action || "list"})`;
    }
    case "forge_comments": return `Comment(${action || "list"})`;
    case "forge_tasks": return `Tasks(${action || "list"})`;
    case "forge_agent_sessions": return `Agent session(${action || "list"})`;
    case "forge_memory": return "Memory";
    case "forge_skills": return "Skills";
    case "forge_sentry": return "Sentry";
    default: {
      const label = toolName.replace(/_/g, " ");
      return `${label.charAt(0).toUpperCase() + label.slice(1)}${detail}`;
    }
  }
}

export function getToolSummary(tc: ToolCall): string {
  const input = tc.input ?? {};
  switch (tc.name) {
    case "Read":
    case "Edit":
    case "Write":
    case "Glob":
      return (input.file_path as string) ?? (input.pattern as string) ?? "";
    case "Bash":
      return ((input.command as string) ?? "").slice(0, 80);
    case "Grep": {
      const pat = input.pattern as string | undefined;
      const path = input.path as string | undefined;
      return pat ? `${pat}${path ? ` in ${path}` : ""}` : "";
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ? first.slice(0, 80) : "";
    }
  }
}

export function getToolLabel(tc: ToolCall): string {
  const input = tc.input ?? {};
  const filePath = (input.file_path as string) ?? "";
  switch (tc.name) {
    case "Edit": return `Updated ${filePath}`;
    case "Write": return `Created ${filePath}`;
    case "Read": return `Read ${filePath}`;
    case "Bash": return `Ran ${((input.command as string) ?? "").slice(0, 60)}`;
    case "Grep": return `Searched for ${(input.pattern as string) ?? ""}${(input.path as string) ? ` in ${input.path}` : ""}`;
    case "Glob": return `Found ${(input.pattern as string) ?? ""}`;
    case "TodoWrite": return "Updated task list";
    case "AskUserQuestion": return "Waiting for input";
    case "Task": return `Agent: ${(input.description as string) ?? (input.subagent_type as string) ?? "subtask"}`;
    case "ToolSearch": return `Searching tools: ${(input.query as string) ?? ""}`;
    case "Skill": return `Skill: ${(input.skill as string) ?? "unknown"}`;
    case "EnterWorktree": return "Creating worktree";
    default: {
      if (tc.name.startsWith("mcp__")) {
        return formatMcpLabel(tc.name, input);
      }
      return tc.name;
    }
  }
}
