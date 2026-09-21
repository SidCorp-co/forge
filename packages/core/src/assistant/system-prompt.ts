export interface ProjectSummary {
  name: string;
  agentConfig?: unknown;
}

export interface AppConfigSummary {
  systemPromptOverride?: string | null | undefined;
}

/** The parts of an agent's self the prompt renders; `orgs/agent-selves.ts` holds the row. */
export interface SelfSummary {
  soul?: string | null | undefined;
  instructions?: string | null | undefined;
  emoji?: string | null | undefined;
  greeting?: string | null | undefined;
}

export interface BuildSystemPromptInput {
  project: ProjectSummary;
  /** The answering handle's self; absent or empty renders nothing (ISS-1034). */
  self?: SelfSummary | null | undefined;
  appConfig?: AppConfigSummary | null | undefined;
  /** Channel-specific assistant persona; ignored when an override is set. */
  persona?: string | null | undefined;
  /** Deterministic project-progress block (ISS-671); always appended when set. */
  progressFacts?: string | null | undefined;
}

function renderWho(self: SelfSummary): string | null {
  const lines: string[] = [];
  const soul = self.soul?.trim();
  const greeting = self.greeting?.trim();
  const emoji = self.emoji?.trim();
  if (soul) lines.push(soul);
  if (greeting) lines.push(`You open with: ${greeting}`);
  if (emoji) lines.push(`Your glyph, where a channel shows one: ${emoji}`);
  return lines.length ? `## Who you are\n${lines.join('\n')}` : null;
}

function renderInstructions(self: SelfSummary): string | null {
  const text = self.instructions?.trim();
  return text ? `## Your standing instructions\n${text}` : null;
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
    const who = input.self ? renderWho(input.self) : null;
    if (who) sections.push(who);
    const lines = [persona || `You are a helpful assistant for project "${input.project.name}".`];
    const agentPrompt = readAgentConfigString(input.project.agentConfig, 'systemPrompt');
    if (agentPrompt) lines.push(agentPrompt);
    sections.push(lines.join('\n'));
    const instructions = input.self ? renderInstructions(input.self) : null;
    if (instructions) sections.push(instructions);
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
