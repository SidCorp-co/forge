export interface ProjectSummary {
  name: string;
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
  /** Channel-specific assistant persona. */
  persona?: string | null | undefined;
  /** Deterministic project-progress block (ISS-671); always appended when set. */
  progressFacts?: string | null | undefined;
  /** The approved lessons that reach the assistant (REQ-50 BC-3), already rendered; absent renders nothing. */
  lessons?: string | null | undefined;
  /** The project's content language block (`@forge/contracts/content-language`); appended after an override too. */
  contentLanguage?: string | null | undefined;
  /** What the project's gate profile changes for a chat (REQ-76 BC-9), already rendered; absent renders nothing. */
  gates?: string | null | undefined;
}

/**
 * The line a chat reads where its project's gate `chat_files_issue` is off (yolo): the base layer's
 * "a chat never files an issue" is the strict and standard rule, and the kernel no longer refuses it.
 */
export function chatGatesBlock(chatFilesIssue: { mode: string; profile: string }): string | null {
  if (chatFilesIssue.mode === 'enforce') return null;
  return `## This project's gate profile\nThis project runs the \`${chatFilesIssue.profile}\` gate profile, which lets agents act first (gate \`chat_files_issue\` off). Here a chat may file the issue itself: where the person asks for development work and confirms it, file it (\`POST /api/projects/:id/issues\`) instead of offering Feedback or a Requirement draft; it meets the same ready check as any issue. The rule that a chat never files an issue holds on strict and standard projects, not this one.`;
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

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const sections: string[] = [];
  const persona = input.persona?.trim();
  const who = input.self ? renderWho(input.self) : null;
  if (who) sections.push(who);
  sections.push(persona || `You are a helpful assistant for project "${input.project.name}".`);
  const instructions = input.self ? renderInstructions(input.self) : null;
  if (instructions) sections.push(instructions);

  const progressFacts = input.progressFacts?.trim();
  if (progressFacts) {
    sections.push(progressFacts);
  }

  const lessons = input.lessons?.trim();
  if (lessons) sections.push(lessons);

  const contentLanguage = input.contentLanguage?.trim();
  if (contentLanguage) sections.push(contentLanguage);

  const gates = input.gates?.trim();
  if (gates) sections.push(gates);

  return sections.join('\n\n');
}
