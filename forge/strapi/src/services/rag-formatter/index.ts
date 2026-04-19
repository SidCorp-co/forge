import type { RelevantContextEntry } from '../agent/system-prompt';

/**
 * Pre-format RAG entries into concise, structured text to reduce token usage.
 * Transforms raw text chunks into structured summaries using metadata.
 */
export function formatRagEntries(entries: RelevantContextEntry[]): RelevantContextEntry[] {
  return entries.map((entry) => {
    const formatted = formatEntry(entry);
    return formatted ? { ...entry, text: formatted } : entry;
  });
}

function formatEntry(entry: RelevantContextEntry): string | null {
  const meta = entry.metadata || {};

  switch (entry.sourceType) {
    case 'issue':
      return formatIssue(entry, meta);
    case 'comment':
      return formatComment(entry, meta);
    case 'skill':
      return formatSkill(entry, meta);
    case 'memory':
      return formatMemory(entry, meta);
    case 'chat_session':
      return formatChatSession(entry, meta);
    case 'mcp_schema':
      return formatMcpSchema(entry, meta);
    case 'hub_task':
      return formatHubTask(entry, meta);
    case 'hub_project':
      return formatHubProject(entry, meta);
    case 'hub_comment':
      return formatHubComment(entry, meta);
    case 'hub_config':
      return formatHubConfig(entry, meta);
    default:
      return null; // Keep original text
  }
}

function formatIssue(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const parts: string[] = [];

  const id = meta.issueId ? `ISS-${meta.issueId}` : entry.sourceId.slice(0, 8);
  const title = meta.title || 'Untitled';
  const status = meta.status || 'unknown';
  const priority = meta.priority || 'unknown';

  parts.push(`${id}: ${title} [${status}, ${priority}]`);

  // Description snippet from original text (first meaningful chunk)
  const descSnippet = entry.text.replace(title, '').trim().slice(0, 300);
  if (descSnippet) {
    parts.push(descSnippet);
  }

  // Suggested solution if available
  if (meta.suggestedSolution) {
    parts.push(`Solution: ${meta.suggestedSolution.slice(0, 400)}`);
  }

  // Acceptance criteria if available
  if (meta.acceptanceCriteria) {
    parts.push(`AC: ${meta.acceptanceCriteria.slice(0, 200)}`);
  }

  return parts.join('\n');
}

function formatComment(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const issueTitle = meta.issueTitle || meta.title || 'unknown issue';
  const body = entry.text.slice(0, 400);
  return `Comment on ${issueTitle}: ${body}`;
}

function formatSkill(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const name = meta.name || meta.title || 'unnamed';
  const desc = entry.text.slice(0, 400);
  return `Skill ${name}: ${desc}`;
}

function formatMemory(_entry: RelevantContextEntry, meta: Record<string, any>): string {
  const cat = meta.category || 'memory';
  const scope = meta.scope === 'project' ? 'project' : 'user';
  return `[${cat}] ${_entry.text}`;
}

function formatMcpSchema(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const section = meta.section || 'schema';
  // Keep schema text but add concise header
  return `[Schema/${section}] ${entry.text.slice(0, 600)}`;
}

function formatHubTask(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const title = meta.title || meta.name || 'Untitled';
  const status = meta.status ? ` [${meta.status}]` : '';
  const assignee = meta.assignee ? ` → ${meta.assignee}` : '';
  return `Task: ${title}${status}${assignee}\n${entry.text.slice(0, 300)}`;
}

function formatHubProject(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const name = meta.name || meta.title || 'Unnamed';
  return `Project: ${name}\n${entry.text.slice(0, 300)}`;
}

function formatHubComment(entry: RelevantContextEntry, meta: Record<string, any>): string {
  const task = meta.taskTitle || meta.title || 'unknown';
  return `Comment on ${task}: ${entry.text.slice(0, 300)}`;
}

function formatChatSession(entry: RelevantContextEntry, meta: Record<string, any>): string {
  return `[Past conversation] ${entry.text.slice(0, 200)}`;
}

function formatHubConfig(entry: RelevantContextEntry, _meta: Record<string, any>): string {
  return `[Config] ${entry.text.slice(0, 400)}`;
}
