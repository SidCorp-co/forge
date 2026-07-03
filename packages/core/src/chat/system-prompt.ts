/**
 * v1 EPIC 1 (ISS-294 / PR-B) — Minimal system-prompt builder.
 *
 * No RAG, no rolling stats — explicitly the v1 minimum. The prompt is project
 * name + description + optional `app_config.systemPromptOverride` + a
 * serialized `pageContext` block when the caller passes one.
 *
 * ISS-609 adds two optional blocks for external channels (Rocket.Chat):
 *   - `persona` — replaces the generic assistant line with a caller-supplied
 *     persona (the Forge-assistant persona for the RC bot). The project's
 *     `systemPromptOverride` still wins over it.
 *   - `conversationContext` — the seeded recent-channel-discussion block,
 *     appended as its own section regardless of override.
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
  /** Channel-specific assistant persona; ignored when an override is set. */
  persona?: string | null | undefined;
  /** Recent-conversation seed (external channels); always appended when set. */
  conversationContext?: string | null | undefined;
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
  const persona = input.persona?.trim();
  if (override) {
    sections.push(override);
  } else {
    const lines = [persona || `You are a helpful assistant for project "${input.project.name}".`];
    const agentPrompt = readAgentSystemPrompt(input.project.agentConfig);
    if (agentPrompt) lines.push(agentPrompt);
    sections.push(lines.join('\n'));
  }

  const conversation = input.conversationContext?.trim();
  if (conversation) {
    sections.push(
      `Conversation context — the discussion that led to this message (if it references older matter, use the available history tools before concluding):\n${conversation}`,
    );
  }

  if (input.pageContext && Object.keys(input.pageContext).length > 0) {
    sections.push(`Page context:\n${JSON.stringify(input.pageContext, null, 2)}`);
  }

  return sections.join('\n\n');
}
