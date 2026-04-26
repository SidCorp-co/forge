/**
 * v1 EPIC 1 (ISS-294 / PR-B) — Minimal system-prompt builder.
 *
 * No RAG, no tools, no rolling stats — explicitly the v1 minimum. A later
 * epic will port the full retrieval + agent-tools pipeline (see ISS-270 plan
 * "Out of scope"). The v1 prompt is project name + description + optional
 * `app_config.systemPromptOverride` + a serialized `pageContext` block when
 * the caller passes one.
 */

export interface ProjectSummary {
  name: string;
  agentConfig?: unknown;
}

export interface AppConfigSummary {
  systemPromptOverride?: string | null | undefined;
}

export interface BuildSystemPromptInput {
  project: ProjectSummary;
  appConfig?: AppConfigSummary | null | undefined;
  pageContext?: Record<string, unknown> | null | undefined;
}

function readAgentSystemPrompt(agentConfig: unknown): string | null {
  if (!agentConfig || typeof agentConfig !== 'object') return null;
  const value = (agentConfig as Record<string, unknown>).systemPrompt;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const sections: string[] = [];
  const override = input.appConfig?.systemPromptOverride?.trim();
  if (override) {
    sections.push(override);
  } else {
    const lines = [`You are a helpful assistant for project "${input.project.name}".`];
    const agentPrompt = readAgentSystemPrompt(input.project.agentConfig);
    if (agentPrompt) lines.push(agentPrompt);
    sections.push(lines.join('\n'));
  }

  if (input.pageContext && Object.keys(input.pageContext).length > 0) {
    sections.push(`Page context:\n${JSON.stringify(input.pageContext, null, 2)}`);
  }

  return sections.join('\n\n');
}
