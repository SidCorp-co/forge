// The steward says what a lesson owed a check is about, where its record does not (ISS-1167): one
// drafted before the record carried it. It reads the lesson and the corrections it learned from, never
// its scope, and answers `app` or `process`; the lessons pass writes that through the lessons module
// (`lessons/decide.ts:classifyLesson`) and then files the check or routes it. Where the model gives no
// usable answer, the lesson stays owed its classification, named in the log, and is asked again on the
// next pass: it is filed neither way by default.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import { LESSON_ABOUTS, lessonKey } from '@forge/contracts/lessons';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import type { OwedCheck } from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';

const CLASSIFY_MAX_TOKENS = 300;

export const classifySchema = z.object({
  about: z.enum(LESSON_ABOUTS),
  reason: z.string().min(1).max(REASON_SENTENCE_MAX),
});
export type LessonClassification = z.infer<typeof classifySchema>;

/** How the pass classifies a lesson: the fast model through the gateway, or a test's own answer. */
export type Classifier = (
  projectId: string,
  owed: OwedCheck,
) => Promise<LessonClassification | null>;

/** The steward's own statement of the two kinds, the same words the grouping asks a proposal by. */
export const ABOUT_WORDS =
  "`about`: `app` when the corrections are about the app's own behaviour (a screen, a field, a flow, a page's copy), which a check in the project's code can catch; `process` when they are about an agent's judgement or a Forge step (how a requirement, design, issue or reply was written or decided), which no code in the project's repo can. Read the corrections, not where the lesson applies.";

export function classifyPrompt(owed: OwedCheck): string {
  return [
    "You are the project's steward. The approved lesson below keeps being corrected, and its record does not say what it is about; say it, so its check goes where it can be made.",
    ABOUT_WORDS,
    'Always give a one-sentence `reason`.',
    `The lesson: ${lessonKey(owed.number)}: ${owed.sentence}`,
    `The corrections it learned from:\n${markUntrusted(
      owed.reasons.map((r) => `- ${r}`).join('\n') || '(none)',
      { source: 'the corrections people said' },
    )}`,
  ].join('\n\n');
}

export const modelClassifier: Classifier = async (projectId, owed) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'a lesson classified' },
    classifyPrompt(owed),
    classifySchema,
    { maxTokens: CLASSIFY_MAX_TOKENS },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, lesson: lessonKey(owed.number), miss: answer.miss, detail: answer.detail },
    'steward: a lesson was not classified',
  );
  return null;
};
