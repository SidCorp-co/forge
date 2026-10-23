// The steward and core settle every lesson (REQ-50 r2 BC-2, BC-5; docs/proposals/lessons.md): each
// proposal is checked by the fast model against the corrections it came from, the approved lessons and
// the requirements and designs in its scope, then approved, edited and approved, or rejected with a
// reason; each confusion an agent reported is judged on both sides and its recommendation, then the
// lesson is kept, edited or retired with a reason. Every act goes through the lessons module's own
// decisions as the steward account, so the kernel keeps each move and its reason. No person is asked.
// Where the model gives no usable answer, or a decision is refused, the item stays waiting, is named
// in the log, and is tried again on the next pass: nothing is approved by default.

import {
  LESSON_ITEM_KINDS,
  LESSON_LIMITS,
  LESSON_RESOLUTIONS,
  type LessonScope,
  lessonKey,
} from '@forge/contracts/lessons';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import {
  approveLesson,
  decideConfusion,
  deferConfusion,
  deferLesson,
  type GatherLesson,
  gatherInput,
  type LessonActor,
  type LessonEdit,
  type OpenConfusion,
  openConfusions,
  type ProposedLesson,
  proposedLessons,
  rejectLesson,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal, type RefusalError } from '../lib/refusal.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { lessonScopeText } from './lessons-scope.js';

const JUDGE_MAX_TOKENS = 800;
const sentence = z.string().min(1).max(LESSON_LIMITS.sentenceChars);
const reason = z.string().min(1).max(600);

const reviewSchema = z.object({
  verdict: z.enum(['approve', 'edit', 'reject']),
  sentence: sentence.nullable(),
  scope: z.enum(['project', 'area', 'item_kind']).nullable(),
  areaId: z.string().nullable(),
  itemKind: z.enum(LESSON_ITEM_KINDS).nullable(),
  reason,
});
export type LessonReview = z.infer<typeof reviewSchema>;

const settleSchema = z.object({
  resolution: z.enum(LESSON_RESOLUTIONS),
  sentence: sentence.nullable(),
  reason,
});
export type ConfusionVerdict = z.infer<typeof settleSchema>;

export interface ReviewInput {
  lesson: ProposedLesson;
  approved: GatherLesson[];
  scope: string;
}
export interface SettleInput {
  confusion: OpenConfusion;
  scope: string;
}

/** How the pass reviews a proposal: the fast model through the gateway, or a test's own answer. */
export type Reviewer = (projectId: string, input: ReviewInput) => Promise<LessonReview | null>;
/** How the pass settles a confusion: the fast model through the gateway, or a test's own answer. */
export type Settler = (projectId: string, input: SettleInput) => Promise<ConfusionVerdict | null>;

const scopeWords = (scope: LessonScope) =>
  scope.kind === 'project'
    ? 'the whole project'
    : scope.kind === 'area'
      ? `the requirement area ${scope.areaId}`
      : `every ${scope.itemKind} an agent produces`;

export function reviewPrompt(input: ReviewInput): string {
  const { lesson } = input;
  return [
    "You are the project's steward. You proposed the lesson below from corrections made to the project's agents; now check it before any agent applies it. No person reviews it after you.",
    '- `approve` when its sentence says what the corrections meant, in one imperative an agent can apply, and contradicts no requirement, design or approved lesson below.',
    '- `edit` when the point is right but the wording or the scope is not: give the new `sentence`, or the narrowest `scope` that fits (`area` with its areaId, `item_kind` with its itemKind), or both.',
    '- `reject` when the corrections do not make one point, when it contradicts a requirement, design or approved lesson (name which), or when an approved lesson already says it.',
    'Always give a one-sentence `reason`.',
    `The lesson: ${lessonKey(lesson.number)}, scope ${scopeWords(lesson.scope)}${lesson.supersedes ? `, replacing ${lessonKey(lesson.supersedes)}` : ''}: ${lesson.sentence}`,
    `The corrections it came from:\n${markUntrusted(
      lesson.corrections.map((c) => `- ${c.itemKey}: ${c.reason}`).join('\n') || '(none)',
      { source: 'the corrections people said' },
    )}`,
    `Approved lessons:\n${input.approved.map((l) => `- ${lessonKey(l.number)} (${l.scope}): ${l.sentence}`).join('\n') || '(none)'}`,
    input.scope,
  ].join('\n\n');
}

export function settlePrompt(input: SettleInput): string {
  const { confusion: c } = input;
  const against = c.other.lesson
    ? `${c.other.lesson}: ${c.other.sentence ?? ''}`
    : (c.other.ref ?? 'nothing named');
  return [
    "You are the project's steward. An agent stopped applying the lesson below and reported a confusion instead of guessing; the lesson is held, out of every prompt, until you settle it. No person decides it after you.",
    '- `keep` when the lesson stands as written and the other side does not defeat it.',
    '- `edit` when a clearer or narrower sentence settles it: give the new `sentence` (or leave it null to take the recommended one).',
    '- `retire` when the lesson is wrong, contradicts a requirement or design below, or does more harm than good.',
    'Always give a one-sentence `reason`.',
    `The lesson: ${lessonKey(c.lesson.number)}, scope ${scopeWords(c.lesson.scope)}: ${c.lesson.sentence}`,
    `The confusion (${c.kind}), held against ${against}:\n${markUntrusted(
      [
        `- The lesson's side: ${c.sides.lesson}`,
        `- The other side: ${c.sides.other}`,
        `- Recommended: ${c.recommended.resolution}${c.recommended.sentence ? `, reading: ${c.recommended.sentence}` : ''}`,
      ].join('\n'),
      { source: 'the agent that reported it' },
    )}`,
    input.scope,
  ].join('\n\n');
}

export const modelReviewer: Reviewer = async (projectId, input) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'a proposed lesson reviewed' },
    reviewPrompt(input),
    reviewSchema,
    { maxTokens: JUDGE_MAX_TOKENS },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, lesson: lessonKey(input.lesson.number), miss: answer.miss, detail: answer.detail },
    'steward: a proposed lesson was not reviewed',
  );
  return null;
};

export const modelSettler: Settler = async (projectId, input) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'a lesson confusion settled' },
    settlePrompt(input),
    settleSchema,
    { maxTokens: JUDGE_MAX_TOKENS },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, confusion: input.confusion.id, miss: answer.miss, detail: answer.detail },
    'steward: a lesson confusion was not settled',
  );
  return null;
};

/** The edit a review asks for, or null where it names none it can carry. */
function editOf(r: LessonReview): LessonEdit | null {
  let scope: LessonScope | undefined;
  if (r.scope === 'project') scope = { kind: 'project' };
  if (r.scope === 'area') {
    if (!r.areaId) return null;
    scope = { kind: 'area', areaId: r.areaId };
  }
  if (r.scope === 'item_kind') {
    if (!r.itemKind) return null;
    scope = { kind: 'item_kind', itemKind: r.itemKind };
  }
  if (!r.sentence && !scope) return null;
  return { sentence: r.sentence ?? undefined, scope };
}

export interface SettleTally {
  approved: number;
  rejected: number;
  settled: number;
  /** Items left waiting for the next pass: no usable answer, or a refused decision. */
  waiting: number;
}

/**
 * One item left waiting, named in the log with why, and sent to the back of the next pass's reads
 * (`defer`: a proposal by its lesson, a confusion by itself), so an item that keeps failing never
 * holds its place ahead of the rest.
 */
async function wait(
  tally: SettleTally,
  projectId: string,
  item: string,
  why: string,
  defer: () => Promise<void>,
): Promise<void> {
  tally.waiting += 1;
  logger.warn({ projectId, item, why }, 'steward: a lesson item waits for the next pass');
  await defer();
}

/** A refusal leaves the item waiting; anything else is the pass's failure. */
async function refusedWaits(
  act: () => Promise<unknown>,
  onRefused: (err: RefusalError) => Promise<void>,
): Promise<boolean> {
  try {
    await act();
    return true;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    await onRefused(err);
    return false;
  }
}

async function reviewOne(
  projectId: string,
  actor: LessonActor,
  lesson: ProposedLesson,
  input: { approved: GatherLesson[]; review: Reviewer },
  tally: SettleTally,
): Promise<void> {
  const key = lessonKey(lesson.number);
  const scope = await lessonScopeText(projectId, lesson.scope);
  const answer = await input.review(projectId, { lesson, approved: input.approved, scope });
  const back = () => deferLesson(projectId, lesson.number);
  if (!answer) return wait(tally, projectId, key, 'the review gave no answer', back);
  const edit = answer.verdict === 'edit' ? editOf(answer) : undefined;
  if (edit === null) {
    return wait(tally, projectId, key, 'the review asked an edit it did not name', back);
  }
  const refused = (err: RefusalError) =>
    wait(tally, projectId, key, `refused: ${err.message}`, back);
  if (answer.verdict === 'reject') {
    const done = await refusedWaits(
      () => rejectLesson({ projectId, ref: key, actor, reason: answer.reason }),
      refused,
    );
    if (done) tally.rejected += 1;
    return;
  }
  const done = await refusedWaits(
    () => approveLesson({ projectId, ref: key, actor, edit, reason: answer.reason }),
    refused,
  );
  if (done) tally.approved += 1;
}

async function settleOne(
  projectId: string,
  actor: LessonActor,
  confusion: OpenConfusion,
  settle: Settler,
  tally: SettleTally,
): Promise<void> {
  const item = `${lessonKey(confusion.lesson.number)} confusion ${confusion.id}`;
  const scope = await lessonScopeText(projectId, confusion.lesson.scope);
  const answer = await settle(projectId, { confusion, scope });
  const back = () => deferConfusion(projectId, confusion.id);
  if (!answer) return wait(tally, projectId, item, 'the settlement gave no answer', back);
  const done = await refusedWaits(
    () =>
      decideConfusion({
        projectId,
        confusionId: confusion.id,
        actor,
        settle: {
          resolution: answer.resolution,
          sentence: answer.sentence ?? undefined,
          reason: answer.reason,
        },
      }),
    async (err) => {
      // a confusion settled with its lesson, retired on another confusion this pass, waits for nothing
      if (err.refusals.some((r) => r.code === 'LESSON_CONFUSION_DECIDED')) return;
      await wait(tally, projectId, item, `refused: ${err.message}`, back);
    },
  );
  if (done) tally.settled += 1;
}

/** Settle what waits in one project: every proposal reviewed, then every open confusion. */
export async function settleLessons(
  projectId: string,
  stewardId: string,
  judges: { review: Reviewer; settle: Settler },
  tally: SettleTally,
): Promise<void> {
  const actor: LessonActor = { userId: stewardId, agency: 'agent' };
  const proposed = await proposedLessons(projectId);
  if (proposed.length > 0) {
    const approved = (await gatherInput(projectId)).lessons.filter((l) => l.status === 'approved');
    for (const lesson of proposed) {
      await reviewOne(projectId, actor, lesson, { approved, review: judges.review }, tally);
    }
  }
  for (const confusion of await openConfusions(projectId)) {
    await settleOne(projectId, actor, confusion, judges.settle, tally);
  }
}
