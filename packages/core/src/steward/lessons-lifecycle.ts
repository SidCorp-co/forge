// The steward's lifecycle steps for lessons (ISS-1251 §4, §5), run in its lessons pass after it
// settles what waits. Each is a delta, never a rewrite, and each change to a lesson's text is replayed
// before it is adopted:
//  - anchor: a lesson drafted before anchors is given one from its record, or listed as owing one;
//  - re-check: a lesson a landing invalidated is re-admitted, edited or retired;
//  - fold: a lesson that holds is folded into its card as one situation, best-practice line or red
//    flag (an ADD or UPDATE delta, proposed until the card's code carries it, `lessons/card-freshness.ts`),
//    then retired: the card is its durable home.
// Replay: the change is read against the failures it claims to fix (its corrections) and the good
// cases it must not break (the approved lessons in force); one that fixes none of its failures, or
// breaks a good case, is not adopted. Every model call here is a parameter, so a test gives its own.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import { LESSON_LIMITS, lessonAnchorSchema, lessonKey } from '@forge/contracts/lessons';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import {
  anchorLesson,
  applyCarriedDeltas,
  type CardDelta,
  cardsWithProposedDeltas,
  gatherInput,
  invalidatedLessons,
  type LessonActor,
  type LifecycleLesson,
  lessonsPorts,
  lessonsThatHold,
  proposeCardDelta,
  readmitLesson,
  recordScenarioRuns,
  retireLesson,
  settleCardRecheck,
  unanchoredLessons,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { markUntrusted } from '../lib/untrusted-text.js';

const JUDGE_MAX_TOKENS = 800;
const reason = z.string().min(1).max(REASON_SENTENCE_MAX);
const sentence = z.string().min(1).max(LESSON_LIMITS.sentenceChars);

export const anchorSchema = z.object({ anchor: z.string().nullable(), reason });
export const recheckSchema = z.object({
  verdict: z.enum(['readmit', 'edit', 'retire']),
  sentence: sentence.nullish(),
  anchor: z.string().nullish(),
  reason,
});
export const foldSchema = z.object({
  field: z.enum(['situation', 'bestPractice', 'redFlag']),
  op: z.enum(['add', 'update']),
  text: z.string().min(1).max(400),
  replaces: z.string().nullish(),
  reason,
});
export const replaySchema = z.object({
  /** How many of the past failures an agent following the change would have avoided. */
  fixed: z.number().int().min(0),
  /** Each good case the change breaks, quoted. */
  broken: z.array(z.string()).default([]),
  reason,
});
export type ReplayAnswer = z.infer<typeof replaySchema>;

/** What a replay reads: the text as it would read, as it read before, its failures and its good cases. */
export interface ReplayInput {
  change: string;
  was: string | null;
  failures: string[];
  goods: string[];
}

export type Anchorer = (
  projectId: string,
  lesson: LifecycleLesson,
) => Promise<z.infer<typeof anchorSchema> | null>;
export type Rechecker = (
  projectId: string,
  lesson: LifecycleLesson,
) => Promise<z.infer<typeof recheckSchema> | null>;
export type Folder = (
  projectId: string,
  lesson: LifecycleLesson,
) => Promise<z.infer<typeof foldSchema> | null>;
export type Replayer = (projectId: string, input: ReplayInput) => Promise<ReplayAnswer | null>;

/** Whether a replay adopts the change: it breaks no good case and fixes a failure where it claims any. */
export const adopts = (r: ReplayAnswer | null, input: ReplayInput): boolean =>
  r !== null && r.broken.length === 0 && (input.failures.length === 0 || r.fixed > 0);

const untrusted = (lines: string[]) =>
  markUntrusted(lines.map((l) => `- ${l}`).join('\n') || '(none)', {
    source: 'the corrections people said',
  });

export function replayPrompt(input: ReplayInput): string {
  return [
    "You are the project's steward, replaying a change to what agents are taught before it is adopted.",
    'For each past failure, decide whether an agent following the changed text would have avoided it; count those in `fixed`. For each good case, decide whether the change contradicts or breaks it; quote each one it breaks in `broken`. Give a one-sentence `reason`.',
    `The change: ${input.change}`,
    input.was ? `It replaces: ${input.was}` : 'It is new.',
    `Past failures it claims to fix:\n${untrusted(input.failures)}`,
    `Good cases it must not break:\n${input.goods.map((g) => `- ${g}`).join('\n') || '(none)'}`,
  ].join('\n\n');
}

const lessonLine = (l: LifecycleLesson) =>
  `${lessonKey(l.number)}${l.anchor ? ` (anchor ${l.anchor})` : ''}: ${l.sentence}`;

export function anchorPrompt(l: LifecycleLesson): string {
  return [
    "You are the project's steward. The lesson below was drafted before every lesson named what it is about. Name its `anchor` from its record, so the change that moves what it describes retires it.",
    'An anchor is `card:<id>` (a capability card, e.g. `card:support.member`), `REQ-<n> BC-<m>` (a requirement behaviour), or a code path with its symbol (`packages/core/src/x.ts:name`). Name one only where the record shows it; else answer null and say what is missing in `reason`.',
    lessonLine(l),
    `Its corrections:\n${untrusted(l.failures)}`,
  ].join('\n\n');
}

export function recheckPrompt(l: LifecycleLesson): string {
  return [
    "You are the project's steward. A landing changed what the lesson below is about, so it is held and served to no agent until you re-check it against the change.",
    '- `readmit` when it still holds as written; - `edit` with the new `sentence` (and `anchor` if it moved) when the change moved part of it; - `retire` when the change made it wrong or the thing it describes is gone. Give a one-sentence `reason`.',
    lessonLine(l),
    `What changed: ${l.invalidBy ?? 'not recorded'}`,
    `Its corrections:\n${untrusted(l.failures)}`,
  ].join('\n\n');
}

export function foldPrompt(l: LifecycleLesson): string {
  return [
    "You are the project's steward. The lesson below holds: applied again and again, never corrected since. Fold it into its capability card as ONE delta, never a rewrite of the card.",
    '`field`: `situation` (a "when you are … → do …" line), `bestPractice` (how to use it well) or `redFlag` (the wrong way agents take). `op`: `add` a line, or `update` the line it sharpens, quoted exactly in `replaces`. `text`: the line as the card will read it. Give a one-sentence `reason`.',
    lessonLine(l),
    `The corrections it came from:\n${untrusted(l.failures)}`,
  ].join('\n\n');
}

async function modelCall<T extends z.ZodType>(
  projectId: string,
  what: string,
  prompt: string,
  schema: T,
): Promise<z.infer<T> | null> {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what },
    prompt,
    schema,
    {
      maxTokens: JUDGE_MAX_TOKENS,
    },
  );
  if (answer.ok) return answer.value as z.infer<T>;
  logger.warn(
    { projectId, what, miss: answer.miss },
    'steward: a lesson lifecycle step gave no answer',
  );
  return null;
}

export const modelAnchorer: Anchorer = (p, l) =>
  modelCall(p, 'a lesson anchored', anchorPrompt(l), anchorSchema);
export const modelRechecker: Rechecker = (p, l) =>
  modelCall(p, 'an invalidated lesson re-checked', recheckPrompt(l), recheckSchema);
export const modelFolder: Folder = (p, l) =>
  modelCall(p, 'a lesson folded into its card', foldPrompt(l), foldSchema);
export const modelReplayer: Replayer = (p, input) =>
  modelCall(p, 'a teaching change replayed', replayPrompt(input), replaySchema);

export interface LifecycleTally {
  anchored: number;
  /** Lessons still owing an anchor after this pass: listed for the steward, never retired for it. */
  unanchored: number;
  readmitted: number;
  invalidRetired: number;
  folded: number;
  /** Lessons that hold and wait: their anchor names a card no door carries. */
  foldWaiting: number;
  /** Changes a replay did not adopt. */
  replayRefused: number;
  /** Cards whose re-check this pass finished: no lesson anchored on one still waits re-checking. */
  cardsRechecked: number;
  /** Proposed card deltas the card's code now carries, marked applied. */
  deltasApplied: number;
}

export const emptyLifecycleTally = (): LifecycleTally => ({
  anchored: 0,
  unanchored: 0,
  readmitted: 0,
  invalidRetired: 0,
  folded: 0,
  foldWaiting: 0,
  replayRefused: 0,
  cardsRechecked: 0,
  deltasApplied: 0,
});

export interface LifecycleJudges {
  anchor: Anchorer;
  recheck: Rechecker;
  fold: Folder;
  replay: Replayer;
}

/** The approved lessons in force, as good cases a change must not break. */
async function goodCases(projectId: string, except: number): Promise<string[]> {
  return (await gatherInput(projectId)).lessons
    .filter((l) => l.status === 'approved' && l.number !== except)
    .map((l) => `${lessonKey(l.number)}: ${l.sentence}`);
}

/** Runs `act`; a refusal is logged and counted as not done, anything else fails the pass. */
async function refusalLogged(projectId: string, item: string, act: () => Promise<unknown>) {
  try {
    await act();
    return true;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    logger.warn(
      { projectId, item, err: err.message },
      'steward: a lesson lifecycle act was refused',
    );
    return false;
  }
}

async function anchorOwed(
  projectId: string,
  actor: LessonActor,
  j: LifecycleJudges,
  t: LifecycleTally,
) {
  for (const l of await unanchoredLessons(projectId)) {
    const answer = await j.anchor(projectId, l);
    const anchor = answer?.anchor ? lessonAnchorSchema.safeParse(answer.anchor) : null;
    if (!anchor?.success) {
      t.unanchored += 1;
      logger.info(
        { projectId, lesson: lessonKey(l.number), why: answer?.reason ?? 'no answer' },
        'steward: a lesson owes an anchor its record does not show',
      );
      continue;
    }
    const ref = lessonKey(l.number);
    if (
      await refusalLogged(projectId, ref, () =>
        anchorLesson({ projectId, ref, actor, anchor: anchor.data }),
      )
    ) {
      t.anchored += 1;
    }
  }
}

async function recheckInvalid(
  projectId: string,
  actor: LessonActor,
  j: LifecycleJudges,
  t: LifecycleTally,
) {
  const cards = new Set<string>();
  for (const l of await invalidatedLessons(projectId)) {
    if (l.anchor?.startsWith('card:')) cards.add(l.anchor.slice(5));
    await recheckOne(projectId, actor, j, t, l);
  }
  // a card a landing touched is re-checked through what was learned of it: done once none waits
  for (const card of cards) if (await settleCardRecheck(card)) t.cardsRechecked += 1;
}

async function recheckOne(
  projectId: string,
  actor: LessonActor,
  j: LifecycleJudges,
  t: LifecycleTally,
  l: LifecycleLesson,
) {
  const ref = lessonKey(l.number);
  const answer = await j.recheck(projectId, l);
  if (!answer) return;
  if (answer.verdict === 'retire') {
    const why = `Re-checked after ${l.invalidBy}: ${answer.reason}`;
    if (
      await refusalLogged(projectId, ref, () =>
        retireLesson({ projectId, ref, actor, reason: why }),
      )
    ) {
      t.invalidRetired += 1;
    }
    return;
  }
  const anchor = answer.anchor ? lessonAnchorSchema.safeParse(answer.anchor) : null;
  const edit =
    answer.verdict === 'edit'
      ? {
          sentence: answer.sentence ?? undefined,
          anchor: anchor?.success ? anchor.data : undefined,
        }
      : undefined;
  if (edit?.sentence) {
    const input = {
      change: edit.sentence,
      was: l.sentence,
      failures: l.failures,
      goods: await goodCases(projectId, l.number),
    };
    const anchor = edit.anchor ?? l.anchor ?? '';
    const card = anchor.startsWith('card:') ? await lessonsPorts().cardOf(anchor.slice(5)) : null;
    if (!(await replayOnCard(projectId, j.replay, card, input, `${ref} edit`))) {
      t.replayRefused += 1;
      return;
    }
  }
  const done = await refusalLogged(projectId, ref, () =>
    readmitLesson({
      projectId,
      ref,
      actor,
      edit,
      reason: `Re-checked after ${l.invalidBy}: ${answer.reason}`,
    }),
  );
  if (done) t.readmitted += 1;
}

/**
 * Replay a change to a card's teaching and keep each of the card's scenarios' result: a scenario the
 * replay names as broken failed, every other passed. Whether the change is adopted.
 */
async function replayOnCard(
  projectId: string,
  replay: Replayer,
  card: { id: string; scenarios: readonly string[] } | null,
  input: ReplayInput,
  change: string,
): Promise<boolean> {
  const withScenarios = card ? { ...input, goods: [...card.scenarios, ...input.goods] } : input;
  const answer = await replay(projectId, withScenarios);
  if (answer && card && card.scenarios.length > 0) {
    await recordScenarioRuns(
      card.id,
      change,
      card.scenarios.map((scenario) => ({
        scenario,
        passed: !answer.broken.includes(scenario),
        reason: answer.reason,
      })),
    );
  }
  return adopts(answer, withScenarios);
}

async function foldHolding(
  projectId: string,
  actor: LessonActor,
  j: LifecycleJudges,
  t: LifecycleTally,
) {
  for (const l of await lessonsThatHold(projectId)) {
    const ref = lessonKey(l.number);
    const cardId = String(l.anchor).slice('card:'.length);
    const card = await lessonsPorts().cardOf(cardId);
    if (!card) {
      // a lesson anchored to a card no door carries waits; its anchor is the steward's to fix
      t.foldWaiting += 1;
      logger.warn(
        { projectId, lesson: ref, card: cardId },
        'steward: a lesson that holds names no card a door carries',
      );
      continue;
    }
    const answer = await j.fold(projectId, l);
    if (!answer) continue;
    const input = {
      change: answer.text,
      was: answer.replaces ?? null,
      failures: l.failures,
      goods: await goodCases(projectId, l.number),
    };
    if (!(await replayOnCard(projectId, j.replay, card, input, `${ref} fold`))) {
      t.replayRefused += 1;
      continue;
    }
    const delta: CardDelta = {
      field: answer.field,
      op: answer.op,
      text: answer.text,
      ...(answer.op === 'update' && answer.replaces ? { replaces: answer.replaces } : {}),
    };
    const id = await proposeCardDelta(cardId, delta, { projectId, lesson: ref });
    const why = `Folded into card ${cardId} as a ${answer.field} (${answer.op}, delta ${id}): ${answer.reason}`;
    if (
      await refusalLogged(projectId, ref, () =>
        retireLesson({ projectId, ref, actor, reason: why }),
      )
    ) {
      t.folded += 1;
    }
  }
}

/** One project's lifecycle steps: anchors owed, invalidated lessons re-checked, held ones folded. */
export async function runLessonLifecycle(
  projectId: string,
  stewardId: string,
  judges: LifecycleJudges,
  tally: LifecycleTally,
): Promise<void> {
  const actor: LessonActor = { userId: stewardId, agency: 'agent' };
  await anchorOwed(projectId, actor, judges, tally);
  await recheckInvalid(projectId, actor, judges, tally);
  await recheckCardDeltas(projectId, tally);
  await foldHolding(projectId, actor, judges, tally);
}

/**
 * Each card holding a delta this project's lessons proposed is re-checked against its code: a delta
 * whose line the card now reads is applied, and leaves the card's surfaces; the rest stay proposed.
 */
async function recheckCardDeltas(projectId: string, t: LifecycleTally) {
  for (const id of await cardsWithProposedDeltas(projectId)) {
    const card = await lessonsPorts().cardOf(id);
    if (card) t.deltasApplied += await applyCarriedDeltas(card);
  }
}
