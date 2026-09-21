import type { AnswerStyle } from '../db/schema.js';

export interface SpeakerPreferences {
  answerStyle: AnswerStyle;
  assistantInstructions: string | null;
}

export interface SpeakerInput {
  /** The Forge user the newest person message is linked to, or null when nobody Forge knows. */
  speakerUserId: string | null;
  /** The transport's own label for them, for the unlinked sentence only. */
  speakerLabel: string | null;
  /** Their preferences, read by the caller when `speakerUserId` is set. */
  preferences: SpeakerPreferences | null;
}

const STYLE_MEANING: Record<AnswerStyle, string | null> = {
  default: null,
  concise: 'answer in as few sentences as the question needs; no preamble, no recap',
  detailed: 'give the full picture — context, evidence and the reasoning between them',
  bullets: 'answer as a bulleted list; one point per line, prose only where a list cannot carry it',
};

/**
 * What the turn is told about the speaker, or null when there is nothing to say.
 */
export function speakerSection(input: SpeakerInput): string | null {
  if (!input.speakerUserId) {
    if (!input.speakerLabel) return null;
    return `Speaker: the newest message is from ${input.speakerLabel}, who is not linked to a Forge user. No preferences apply to this reply, and nothing may be written on their behalf.`;
  }
  const prefs = input.preferences;
  if (!prefs) return null;
  const lines: string[] = [];
  const meaning = STYLE_MEANING[prefs.answerStyle];
  if (meaning)
    lines.push(`Reply style for the person you are answering: ${prefs.answerStyle} — ${meaning}.`);
  const instructions = prefs.assistantInstructions?.trim();
  if (instructions) lines.push(`Their standing instructions for every reply:\n${instructions}`);
  return lines.length ? lines.join('\n') : null;
}
