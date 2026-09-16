/**
 * v1 EPIC 1 (ISS-294 / PR-B) — the system prompt: persona or `app_config.systemPromptOverride`
 * (the override wins), the handle's SELF around the persona (ISS-1034: who it is before, its
 * standing instructions after — replaced by the override with the persona, because it is the
 * persona's kind of thing), the project's `agentConfig.systemPrompt`, the `personaStyle` knob, and
 * the ISS-671 `progressFacts` block, which survives the override because a kernel fact must not be
 * strippable by a project's prompt customization. No RAG, no rolling stats. The conversation seed
 * and the page context are NOT here — see `turn-context.ts`. What IS here does not all hold still:
 * `progressFacts` renders counters recomputed every turn, so this message is a cache prefix across
 * rounds and not across turns, while `tools[]`, which renders before it, is stable across both
 * (ISS-983).
 */

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
