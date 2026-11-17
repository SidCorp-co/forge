// The steward's lessons pass (REQ-50 r2 BC-2, BC-5..BC-8; docs/proposals/lessons.md): every
// `LESSONS_PASS_MS`, in each project whose steward is on, it asks the fast model to reject each new
// correction that is not one, with a reason, to link each to the lesson it repeats and to group the rest, and proposes each group of
// `LESSON_PROPOSE_MIN` or more as a lesson authored by the steward account. It then settles what waits
// (`lessons-review.ts`): each proposal approved, edited or rejected, and each reported confusion kept,
// edited or retired, each with a reason. It retires each lesson superseded or unused for
// `LESSON_UNUSED_DAYS` days with a reason, and files each owed check by what its record says it is
// about (`lessons-checks.ts`), classifying one whose record does not say first. Lessons are
// internal to Forge (BC-9): no person is asked to decide any of it.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import {
  LESSON_ANCHOR_SHAPE,
  LESSON_ITEM_KINDS,
  LESSON_PROPOSE_MIN,
  LESSON_UNUSED_DAYS,
  type LessonAbout,
  type LessonScope,
  lessonAnchorSchema,
  lessonKey,
} from '@forge/contracts/lessons';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import { moduleBySlug, moduleMapLines } from '../labels/index.js';
import {
  type GatherCorrection,
  type GatherLesson,
  gatherInput,
  lessonsPorts,
  linkRepeats,
  projectsWithLessonWork,
  proposeLesson,
  type RetirementDue,
  recordLessonsMonths,
  rejectCorrections,
  retireLesson,
  retirementsDue,
  threadLines,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { stewardAccountOf } from './account.js';
import { cardChoices } from './lessons-anchor.js';
import { fileChecks } from './lessons-checks.js';
import { ABOUT_WORDS, type Classifier, modelClassifier } from './lessons-classify.js';
import {
  type Anchorer,
  CARD_CHOICES,
  emptyLifecycleTally,
  type Folder,
  type LifecycleTally,
  modelAnchorer,
  modelFolder,
  modelRechecker,
  modelReplayer,
  type Rechecker,
  type Replayer,
  runLessonLifecycle,
} from './lessons-lifecycle.js';
import { type Merger, modelMerger, openPileConsolidations } from './lessons-piles.js';
import {
  modelReviewer,
  modelSettler,
  type Reviewer,
  type Settler,
  type SettleTally,
  settleLessons,
} from './lessons-review.js';
import { stewardStanceOf } from './policy.js';

/** The longest rejection reason the grouping asks for; the store takes up to `REASON_SENTENCE_MAX`. */
export const GROUP_REASON_CHARS = 160;
// the answer is sized by the corrections it reads: each may come back rejected with a reason, and a
// fixed 1500 truncated an answer over sixty corrections, which then parsed as nothing (ISS-867)
const GROUP_BASE_TOKENS = 1500;
const GROUP_TOKENS_PER_CORRECTION = 75;

/** The output budget for grouping `corrections` corrections. */
export const groupingBudget = (corrections: number): number =>
  GROUP_BASE_TOKENS + corrections * GROUP_TOKENS_PER_CORRECTION;
/** How much of each thread post the grouping reads, over a window of up to sixty corrections. */
const GROUP_THREAD_CHARS = 280;

/** One correction as the grouping reads it: what was wrong, then the thread it was said in, where there is one. */
function correctionLine(c: GatherCorrection): string {
  const head = `- ${c.id} [${c.source}, ${c.itemKind} ${c.itemKey}, area ${c.areaId ?? 'none'}]: ${c.reason}`;
  return c.thread?.length
    ? `${head}\n  thread, oldest first, the last post the correction itself:\n${threadLines(c.thread, GROUP_THREAD_CHARS, '    ')}`
    : head;
}

// a list the model leaves out is empty, and a key it leaves out is null: an answer that omits what
// it has nothing to say about is still read, never dropped whole as unreadable (ISS-867)
export const groupingSchema = z.object({
  rejections: z
    .array(z.object({ correction: z.string(), reason: z.string().min(1).max(REASON_SENTENCE_MAX) }))
    .default([]),
  links: z.array(z.object({ correction: z.string(), lesson: z.number().int() })).default([]),
  proposals: z
    .array(
      z.object({
        sentence: z.string().min(1).max(240),
        scope: z.enum(['project', 'area', 'item_kind']),
        // read as said, so a proposal naming none, or another word, is refused by name, not dropped unread
        about: z.string().nullish(),
        // read as said, so a proposal naming no anchor is dropped by name, never admitted unanchored
        anchor: z.string().nullish(),
        areaId: z.string().nullish(),
        itemKind: z.enum(LESSON_ITEM_KINDS).nullish(),
        corrections: z.array(z.string()),
        supersedes: z.number().int().nullish(),
        // the business module the lesson is about, by slug (ISS-1256); null where none fits
        module: z.string().nullish(),
      }),
    )
    .default([]),
});
export type LessonGrouping = z.infer<typeof groupingSchema>;

/** How the pass groups: the fast model through the gateway, or a test's own answer. */
/** A business module as the grouping reads it, to place each lesson it proposes (ISS-1256). */
export interface GroupingModule {
  slug: string;
  name: string;
  description: string | null;
}

export interface GroupingInput {
  corrections: GatherCorrection[];
  lessons: GatherLesson[];
  modules: readonly GroupingModule[];
}

export type Grouper = (projectId: string, input: GroupingInput) => Promise<LessonGrouping | null>;

const moduleLine = (m: GroupingModule) =>
  `- ${m.slug}: ${m.name}${m.description ? ` — ${m.description}` : ''}`;

export function groupingPrompt(
  input: GroupingInput,
  cards: readonly { id: string; purpose: string }[] = [],
): string {
  return [
    "You are the project's steward. People corrected the project's agents; each correction below says what was wrong.",
    `1. Reject a correction that is not one (\`rejections\`: its \`correction\` id and a \`reason\` of one sentence under ${GROUP_REASON_CHARS} characters): it names nothing the agent did wrong, it is a test or probe, or it is a question, thanks or noise. A rejected correction never feeds a lesson. Reject only what plainly is not a correction.`,
    '2. Link a correction to an existing lesson only when it repeats that lesson (`links`: its `correction` id and the `lesson` number).',
    `3. Group the other corrections that make the same point, ${LESSON_PROPOSE_MIN} or more each, and propose one lesson per group (\`proposals\`): one imperative \`sentence\` an agent can apply, the \`corrections\` ids it came from, and a \`scope\`: \`project\`, \`area\` (with the corrections' \`areaId\`) or \`item_kind\` (with an \`itemKind\`: requirement, workflow, mockup, suggestion, issue or chat) — the narrowest that fits. Where a group replaces an approved lesson, name that lesson's number in \`supersedes\`.`,
    `Every proposal says what it is about in ${ABOUT_WORDS}`,
    `Every proposal names its \`anchor\`, what the lesson is about, so the change that moves it retires it: ${LESSON_ANCHOR_SHAPE}. Take it from the corrections' items and threads; a card anchor names only one of the cards below, never an item's id; a group whose anchor they do not show is left for a correction that shows it.`,
    cardChoices(cards),
    `Every proposal names its \`module\`: the slug of the business module below that the lesson is about, as its corrections' items and threads show, or null where none fits, and the lesson waits Unplaced for an agent to place.\nModules:\n${input.modules.map(moduleLine).join('\n') || '(none: every `module` is null)'}`,
    'Corrections on different items make the same point when one general mistake lies behind them: the same rule missed, the same kind of check skipped, the same wording or habit corrected. Say that general rule, not the item.',
    'Leave a correction alone when nothing else makes its point; it waits for a second one.',
    "Before you draft from a correction that carries its thread, read the thread: the person's words answer the posts before them, so the lesson is about what those posts are about (a product's own messages, a record, a step), never by default about the assistant's own reply.",
    `Where the corrections are a person's ruling, the \`sentence\` quotes their words, short, in their language ("…"), and says what it applies to. Where the thread leaves the reading open, the sentence says so ("reading unsure: …") rather than guessing; better still, leave the group for a correction that settles it.`,
    `Lessons:\n${input.lessons.map((l) => `- ${lessonKey(l.number)} (${l.status}, ${l.scope}): ${l.sentence}`).join('\n') || '(none)'}`,
    `Corrections:\n${markUntrusted(input.corrections.map(correctionLine).join('\n'), {
      source: 'the corrections people said',
    })}`,
  ].join('\n\n');
}

export const modelGrouper: Grouper = async (projectId, input) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'corrections grouped into lessons' },
    groupingPrompt(
      input,
      await lessonsPorts().cardsLike(
        input.corrections.map((c) => c.reason).join(' '),
        CARD_CHOICES * 2,
      ),
    ),
    groupingSchema,
    { maxTokens: groupingBudget(input.corrections.length) },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, miss: answer.miss, detail: answer.detail },
    'steward: corrections were not grouped',
  );
  return null;
};

function scopeOf(p: LessonGrouping['proposals'][number]): LessonScope | null {
  if (p.scope === 'project') return { kind: 'project' };
  if (p.scope === 'area') return p.areaId ? { kind: 'area', areaId: p.areaId } : null;
  return p.itemKind ? { kind: 'item_kind', itemKind: p.itemKind } : null;
}

async function proposeGroups(
  projectId: string,
  stewardId: string,
  ids: Set<string>,
  answer: LessonGrouping,
) {
  let proposed = 0;
  let dropped = 0;
  let placed = 0;
  for (const p of answer.proposals) {
    const corrections = [...new Set(p.corrections.filter((c) => ids.has(c)))];
    const scope = scopeOf(p);
    const anchor = lessonAnchorSchema.safeParse(p.anchor ?? '');
    if (!anchor.success) {
      // an unanchored lesson is not admitted (ISS-1251 §4): the draft says what it is missing
      dropped += 1;
      logger.warn(
        { projectId, sentence: p.sentence, anchor: p.anchor ?? null, shape: LESSON_ANCHOR_SHAPE },
        'steward: a proposed group names no anchor it can be invalidated by; it was not proposed',
      );
      continue;
    }
    if (corrections.length < LESSON_PROPOSE_MIN || !scope) {
      // a group the model named that cannot become a lesson is said, never skipped in silence
      dropped += 1;
      logger.warn(
        {
          projectId,
          sentence: p.sentence,
          scope: p.scope,
          named: p.corrections.length,
          open: corrections.length,
        },
        scope
          ? `steward: a proposed group holds fewer than ${LESSON_PROPOSE_MIN} open corrections; it was not proposed`
          : 'steward: a proposed group names a scope without its areaId or itemKind; it was not proposed',
      );
      continue;
    }
    try {
      const moduleId = await moduleIdOf(projectId, p.module);
      await proposeLesson({
        projectId,
        actor: { userId: stewardId, agency: 'agent' },
        ...(moduleId ? { moduleId } : {}),
        body: {
          sentence: p.sentence,
          scope,
          // proposeLesson refuses a missing or unknown one by name, with the valid shape
          about: p.about as LessonAbout,
          anchor: anchor.data,
          corrections,
          ...(p.supersedes ? { supersedes: p.supersedes } : {}),
        },
      });
      for (const c of corrections) ids.delete(c);
      proposed += 1;
      if (moduleId) placed += 1;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      dropped += 1;
      logger.warn({ projectId, err: err.message }, 'steward: a lesson proposal was refused');
    }
  }
  return { proposed, dropped, placed };
}

/**
 * The module the grouping placed a proposal in, by its slug; one the project has no module for is
 * said by name and the lesson is proposed Unplaced, never dropped for it and never placed elsewhere.
 */
async function moduleIdOf(projectId: string, slug: string | null | undefined) {
  if (!slug?.trim()) return undefined;
  try {
    return (await moduleBySlug(projectId, slug.trim())).id;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    logger.warn(
      { projectId, module: slug, err: err.message },
      'steward: a proposed lesson names no module of this project; it is proposed unplaced',
    );
    return undefined;
  }
}

const retireWhy = (due: RetirementDue) =>
  due.reason === 'superseded'
    ? `Superseded by ${due.supersededBy ? lessonKey(due.supersededBy) : 'a newer lesson'}.`
    : `No agent applied or opened it in ${LESSON_UNUSED_DAYS} days.`;

/** Retire each lesson now due (BC-7), as the steward, with its reason; none is deleted. */
async function retireDue(projectId: string, stewardId: string, now: Date): Promise<number> {
  let retired = 0;
  for (const due of await retirementsDue(projectId, now)) {
    try {
      await retireLesson({
        projectId,
        ref: lessonKey(due.number),
        actor: { userId: stewardId, agency: 'agent' },
        reason: retireWhy(due),
      });
      retired += 1;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      logger.warn(
        { projectId, lesson: lessonKey(due.number), err: err.message },
        'steward: a due retirement was refused; it waits for the next pass',
      );
    }
  }
  return retired;
}

export interface LessonsPassTally extends SettleTally, LifecycleTally {
  projects: number;
  /** Corrections the steward rejected as not corrections; `rejected` counts proposals it rejected. */
  correctionsRejected: number;
  linked: number;
  proposed: number;
  /** Groups the model proposed that did not become a lesson: too few open corrections, no scope, or refused. */
  dropped: number;
  /** Proposals placed in the business module their grouping named (ISS-1256); the rest sit Unplaced. */
  placed: number;
  /** Projects whose corrections the model gave no readable grouping for (logged with why). */
  ungrouped: number;
  retired: number;
  checks: number;
  /** Lessons owed a check whose record does not say what they are about, and the steward gave none. */
  unclassified: number;
  /** Consolidation items opened for piles past their cap (one per pile; a standing one is not reopened). */
  consolidations: number;
  /** Projects whose piles could not be read this pass (logged with why); their lessons still had their pass. */
  pilesUnread: number;
  failed: number;
}

interface Judges {
  group: Grouper;
  review: Reviewer;
  settle: Settler;
  classify: Classifier;
  anchor: Anchorer;
  recheck: Rechecker;
  fold: Folder;
  replay: Replayer;
  merge: Merger;
}

async function passProject(projectId: string, now: Date, judges: Judges, tally: LessonsPassTally) {
  const { group } = judges;
  const stewardId = await stewardAccountOf(projectId);
  const gathered = await gatherInput(projectId);
  if (gathered.corrections.length > 0) {
    const modules = (await moduleMapLines(projectId)).map(({ slug, name, description }) => ({
      slug,
      name,
      description,
    }));
    const input = { ...gathered, modules };
    const answer = await group(projectId, input);
    if (answer) {
      const ids = new Set(input.corrections.map((c) => c.id));
      const rejected = await rejectCorrections(
        projectId,
        stewardId,
        answer.rejections.filter((r) => ids.has(r.correction)),
      );
      tally.correctionsRejected += rejected.length;
      for (const id of rejected) ids.delete(id);
      const links = answer.links.filter((l) => ids.has(l.correction));
      tally.linked += await linkRepeats(projectId, links);
      for (const l of links) ids.delete(l.correction);
      const groups = await proposeGroups(projectId, stewardId, ids, answer);
      tally.proposed += groups.proposed;
      tally.dropped += groups.dropped;
      tally.placed += groups.placed;
    } else {
      tally.ungrouped += 1;
    }
  }
  await settleLessons(projectId, stewardId, judges, tally);
  await runLessonLifecycle(projectId, stewardId, judges, tally);
  tally.retired += await retireDue(projectId, stewardId, now);
  await fileChecks(projectId, stewardId, judges.classify, tally);
  try {
    tally.consolidations += await openPileConsolidations(projectId, stewardId, judges.merge);
  } catch (err) {
    // the piles are read beside the lessons, never in their way: a read that fails is named and counted
    tally.pilesUnread += 1;
    logger.error({ projectId, err }, 'steward: the piles could not be read; consolidation waits');
  }
  await recordLessonsMonths(projectId, now);
}

/** One pass over every project with lesson work whose steward is on. */
export async function runLessonsPass(
  opts: {
    now?: Date;
    group?: Grouper;
    review?: Reviewer;
    settle?: Settler;
    classify?: Classifier;
    anchor?: Anchorer;
    recheck?: Rechecker;
    fold?: Folder;
    replay?: Replayer;
    merge?: Merger;
    projectIds?: readonly string[];
  } = {},
): Promise<LessonsPassTally> {
  const now = opts.now ?? new Date();
  const judges: Judges = {
    group: opts.group ?? modelGrouper,
    review: opts.review ?? modelReviewer,
    settle: opts.settle ?? modelSettler,
    classify: opts.classify ?? modelClassifier,
    anchor: opts.anchor ?? modelAnchorer,
    recheck: opts.recheck ?? modelRechecker,
    fold: opts.fold ?? modelFolder,
    replay: opts.replay ?? modelReplayer,
    merge: opts.merge ?? modelMerger,
  };
  const tally: LessonsPassTally = {
    projects: 0,
    correctionsRejected: 0,
    linked: 0,
    proposed: 0,
    dropped: 0,
    placed: 0,
    ungrouped: 0,
    approved: 0,
    rejected: 0,
    settled: 0,
    waiting: 0,
    retired: 0,
    checks: 0,
    unclassified: 0,
    consolidations: 0,
    pilesUnread: 0,
    failed: 0,
    ...emptyLifecycleTally(),
  };
  for (const projectId of opts.projectIds ?? (await projectsWithLessonWork(now))) {
    if (!(await stewardStanceOf(projectId)).enabled) continue;
    tally.projects += 1;
    try {
      await passProject(projectId, now, judges, tally);
    } catch (err) {
      // one project's failure is named and counted; the other projects still get their pass
      tally.failed += 1;
      logger.error({ err, projectId }, 'steward: the lessons pass failed on a project');
    }
  }
  return tally;
}
