/**
 * v1 EPIC 1 (ISS-294 / PR-B) — the system prompt: persona or `app_config.systemPromptOverride`
 * (the override wins), the project's `agentConfig.systemPrompt`, the `personaStyle` knob, and the
 * ISS-671 `progressFacts` block, which survives the override because a kernel fact must not be
 * strippable by a project's prompt customization. No RAG, no rolling stats. Everything that changes
 * per turn (the conversation seed, the page context) is NOT here — see `turn-context.ts`: the
 * system message plus `tools[]` is the prompt-cache prefix and must stay byte-stable across turns.
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
  /** Channel-specific assistant persona; ignored when an override is set. */
  persona?: string | null | undefined;
  /** Deterministic project-progress block (ISS-671); always appended when set. */
  progressFacts?: string | null | undefined;
}

function readAgentConfigString(agentConfig: unknown, key: string): string | null {
  if (!agentConfig || typeof agentConfig !== 'object') return null;
  const value = (agentConfig as Record<string, unknown>)[key];
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
    const agentPrompt = readAgentConfigString(input.project.agentConfig, 'systemPrompt');
    if (agentPrompt) lines.push(agentPrompt);
    sections.push(lines.join('\n'));
  }

  // ISS-609 follow-up — per-project reply-style knob (`agentConfig.personaStyle`,
  // set from project settings → Integrations → Rocket.Chat). Additive: it tunes
  // tone/format on TOP of the persona's safety rules, and still applies when an
  // override replaced the base persona.
  const style = readAgentConfigString(input.project.agentConfig, 'personaStyle');
  if (style) {
    sections.push(`Reply style & personality (project-configured):\n${style}`);
  }

  const progressFacts = input.progressFacts?.trim();
  if (progressFacts) {
    sections.push(progressFacts);
  }

  return sections.join('\n\n');
}
