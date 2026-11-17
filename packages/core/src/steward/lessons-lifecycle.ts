// The steward's lifecycle steps for lessons (ISS-1251 §4, §5), run in its lessons pass after it
// settles what waits. Each is a delta, never a rewrite, and each change to a lesson's text is replayed
// before it is adopted:
//  - anchor: a lesson drafted before anchors is given one from its record, or listed as owing one;
//  - re-check: a lesson a landing invalidated is re-admitted, edited or retired;
//  - fold: a lesson that holds is folded into its card as one situation, best-practice line or red
//    flag (an ADD or UPDATE delta, proposed until the card's code carries it, `lessons/card-freshness.ts`),
//    then retired: the card is its durable home.
// Replay: the change is read against the failures it claims to fix (its corrections) and the good
// cases it must not break (the approved lessons in force, and its card's scenarios); one that fixes
// none of its failures, or breaks a good case, is not adopted. A change to a card's teaching is also
// replayed on the card's scenarios as the card reads before and after it (`lessons/scenario-replay.ts`),
// with no model: one that makes a scenario that held fail is not adopted, whatever the model says.
// Every model call here is a parameter, so a test gives its own.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import { LESSON_LIMITS, lessonAnchorSchema, lessonKey } from '@forge/contracts/lessons';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import {
  anchorLesson,
  applyCarriedDeltas,
  type CardDelta,
  type CardScenario,
  type CardText,
  cardsWithProposedDeltas,
  gatherInput,
  improves,
  invalidatedLessons,
  type LessonActor,
  type LifecycleLesson,
  lessonsPorts,
  lessonsThatHold,
  proposeCardDelta,
  readmitLesson,
  recordScenarioRuns,
  replayChange,
  replayScenarios,
  retireLesson,
  settleCardRecheck,
  teachingOf,
  unanchoredLessons,
  withDelta,
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

/** The cards a step offers an anchor from: the nearest the lesson's words (`lessonsPorts().cardsLike`). */
export type CardChoices = readonly { id: string; purpose: string }[];

export type Anchorer = (
  projectId: string,
  lesson: LifecycleLesson,
  cards: CardChoices,
) => Promise<z.infer<typeof anchorSchema> | null>;
export type Rechecker = (
  projectId: string,
  lesson: LifecycleLesson,
  cards: CardChoices,
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

/**
 * The anchor a step takes from its model's answer: a valid anchor, and a card one only where the step
 * offered that card (or `named` names it: a confusion's raiser saying which card the lesson is about).
 * Round 1's prompt offered no cards and gave `card:support.member` as its example, and the steward
 * anchored ten unrelated lessons there (ISS-1251 c4): a card the step never offered is a guess, and
 * is not taken, so no example and no card the model merely knows can draw lessons to it.
 */
export function takenAnchor(
  anchor: string | null | undefined,
  offered: CardChoices,
  named = '',
): string | null {
  const parsed = anchor ? lessonAnchorSchema.safeParse(anchor) : null;
  if (!parsed?.success) return null;
  if (!parsed.data.startsWith('card:')) return parsed.data;
  const id = parsed.data.slice('card:'.length);
  return offered.some((c) => c.id === id) || named.includes(parsed.data) ? parsed.data : null;
}

/** The cards an anchor may name, as a prompt lists them: each by its id and what its door does. */
export const cardChoices = (cards: readonly { id: string; purpose: string }[]): string =>
  cards.length > 0
    ? `Cards whose doors read nearest it (an anchor names one of these, or none):\n${cards.map((c) => `- card:${c.id}: ${c.purpose}`).join('\n')}`
    : 'No card reads near it: anchor it to a requirement behaviour or code, or to none.';

/** The anchor step's prompt: the cards nearest the lesson, never an example to copy (ISS-1251 c4). */
export function anchorPrompt(
  l: LifecycleLesson,
  cards: readonly { id: string; purpose: string }[] = [],
): string {
  return [
    "You are the project's steward. The lesson below was drafted before every lesson named what it is about. Name its `anchor` from its record, so the change that moves what it describes retires it.",
    "An anchor is `card:<id>` (the capability card of the door the lesson is about, only one listed below), `REQ-<n> BC-<m>` (a requirement behaviour), or a code path with its symbol (`packages/core/src/x.ts:name`). Name one only where the record shows the lesson is about it, never the nearest-sounding one and never an item's id; else answer null and say what is missing in `reason`.",
    lessonLine(l),
    cardChoices(cards),
    `Its corrections:\n${untrusted(l.failures)}`,
  ].join('\n\n');
}

export function recheckPrompt(l: LifecycleLesson, cards: CardChoices = []): string {
  return [
    "You are the project's steward. A landing changed what the lesson below is anchored to, so it is held and served to no agent until you re-check it against the change.",
    '- `readmit` when it still holds as written; - `edit` with the new `sentence` when the change moved part of it; - `retire` when the change made it wrong or the thing it describes is gone. Give a one-sentence `reason`.',
    "First ask whether its anchor is what the lesson is about at all: a card's change invalidates every lesson on it, those wrongly anchored there too. Where the anchor names something the lesson is not about, readmit or edit it with the right `anchor` (one of the cards below, a `REQ-<n> BC-<m>` or a code path), never the anchor it had; else leave `anchor` null.",
    lessonLine(l),
    `What changed: ${l.invalidBy ?? 'not recorded'}`,
    cardChoices(cards),
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

/** How many cards the anchor step and the grouping are shown to choose from. */
export const CARD_CHOICES = 12;

/** The cards a lifecycle step offers for one lesson: the nearest its sentence and corrections. */
const offeredFor = (l: LifecycleLesson) =>
  lessonsPorts().cardsLike([l.sentence, ...l.failures].join(' '), CARD_CHOICES);

export const modelAnchorer: Anchorer = async (p, l, cards) =>
  modelCall(p, 'a lesson anchored', anchorPrompt(l, cards), anchorSchema);
export const modelRechecker: Rechecker = (p, l, cards) =>
  modelCall(p, 'an invalidated lesson re-checked', recheckPrompt(l, cards), recheckSchema);
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
    const offered = await offeredFor(l);
    const answer = await j.anchor(projectId, l, offered);
    const anchor = takenAnchor(answer?.anchor, offered);
    if (!anchor) {
      t.unanchored += 1;
      logger.info(
        {
          projectId,
          lesson: lessonKey(l.number),
          answered: answer?.anchor ?? null,
          why: answer?.reason ?? 'no answer',
        },
        'steward: a lesson owes an anchor its record does not show, or one no offered card is',
      );
      continue;
    }
    const ref = lessonKey(l.number);
    if (
      await refusalLogged(projectId, ref, () =>
        anchorLesson({ projectId, ref, actor, anchor }),
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
  // a card a landing touched is re-checked through what was learned of it: done once none waits, and
  // its scenarios are replayed on the text the landing left it with
  for (const id of cards) {
    if (!(await settleCardRecheck(id))) continue;
    t.cardsRechecked += 1;
    const card = await lessonsPorts().cardOf(id);
    if (card && card.scenarios.length > 0) {
      await recordScenarioRuns(id, 're-check', replayScenarios(card.scenarios, teachingOf(card)));
    }
  }
}

async function recheckOne(
  projectId: string,
  actor: LessonActor,
  j: LifecycleJudges,
  t: LifecycleTally,
  l: LifecycleLesson,
) {
  const ref = lessonKey(l.number);
  const offered = await offeredFor(l);
  const answer = await j.recheck(projectId, l, offered);
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
  // a re-check may move the anchor on a readmit too: a lesson wrongly anchored is readmitted where it
  // belongs, never back on the card whose change it never described (ISS-1251 c4)
  const anchor = takenAnchor(answer.anchor, offered) ?? undefined;
  const sentence = answer.verdict === 'edit' ? (answer.sentence ?? undefined) : undefined;
  const edit = sentence || anchor ? { sentence, anchor } : undefined;
  if (edit?.sentence) {
    const input = {
      change: edit.sentence,
      was: l.sentence,
      failures: l.failures,
      goods: await goodCases(projectId, l.number),
    };
    const anchor = edit.anchor ?? l.anchor ?? '';
    const card = anchor.startsWith('card:') ? await lessonsPorts().cardOf(anchor.slice(5)) : null;
    // a lesson is served beside its card, so the card teaches its text with the lesson's sentence
    const read = (c: CardText, sentence: string) => `${teachingOf(c)}\n${sentence}`;
    const teaching = card
      ? { before: read(card, l.sentence), after: read(card, edit.sentence) }
      : null;
    if (!(await replayOnCard(projectId, j.replay, card, teaching, input, `${ref} edit`))) {
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

/** A scenario as a good case the model's replay must not break, named so its answer can quote it. */
const goodCase = (s: CardScenario) =>
  `${s.name}: when ${s.situation}, ${s.good}${s.bad ? ` (never: ${s.bad})` : ''}`;

/**
 * Replay a change to a card's teaching and keep each of the card's scenarios' result: a scenario fails
 * where the teaching as the change leaves it no longer says what its good use needs, or where the
 * model's replay names it broken. The change is adopted only where it improves the card: no scenario
 * that held before fails after it, the model breaks no good case, and it fixes a past failure or makes
 * a scenario hold that failed before. Whether it is adopted.
 */
async function replayOnCard(
  projectId: string,
  replay: Replayer,
  card: CardText | null,
  teaching: { before: string; after: string } | null,
  input: ReplayInput,
  change: string,
): Promise<boolean> {
  const scenarios = card?.scenarios ?? [];
  const withScenarios = { ...input, goods: [...scenarios.map(goodCase), ...input.goods] };
  const answer = await replay(projectId, withScenarios);
  const verdict = replayChange(scenarios, teaching?.before ?? '', teaching?.after ?? '');
  const brokenBy = (name: string) => answer?.broken.find((b) => b.includes(name));
  if (card && scenarios.length > 0) {
    await recordScenarioRuns(
      card.id,
      change,
      verdict.after.map((run) => {
        const broken = brokenBy(run.scenario);
        return broken && run.passed
          ? {
              scenario: run.scenario,
              passed: false,
              reason: `the replay found it broken: ${broken}`,
            }
          : run;
      }),
    );
  }
  if (verdict.regressed.length > 0) {
    logger.info(
      { projectId, card: card?.id, change, regressed: verdict.regressed },
      'steward: a change to a card is not adopted, it fails a scenario that held',
    );
  }
  const clean = answer !== null && answer.broken.length === 0;
  const fixed = answer !== null && (withScenarios.failures.length === 0 || answer.fixed > 0);
  return clean && improves(verdict, fixed);
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
    const delta: CardDelta = {
      field: answer.field,
      op: answer.op,
      text: answer.text,
      ...(answer.op === 'update' && answer.replaces ? { replaces: answer.replaces } : {}),
    };
    const teaching = { before: teachingOf(card), after: teachingOf(withDelta(card, delta)) };
    if (!(await replayOnCard(projectId, j.replay, card, teaching, input, `${ref} fold`))) {
      t.replayRefused += 1;
      continue;
    }
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
