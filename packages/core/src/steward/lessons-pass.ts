// The steward's lessons pass (REQ-50 r2 BC-2, BC-5..BC-8; docs/proposals/lessons.md): every
// `LESSONS_PASS_MS`, in each project whose steward is on, it asks the fast model to reject each new
// correction that is not one, with a reason, to link each to the lesson it repeats and to group the rest, and proposes each group of
// `LESSON_PROPOSE_MIN` or more as a lesson authored by the steward account. It then settles what waits
// (`lessons-review.ts`): each proposal approved, edited or rejected, and each reported confusion kept,
// edited or retired, each with a reason. It retires each lesson superseded or unused for
// `LESSON_UNUSED_DAYS` days with a reason, and files each owed check as a draft issue. Lessons are
// internal to Forge (BC-9): no person is asked to decide any of it.

import { REASON_SENTENCE_MAX } from '@forge/contracts/comments';
import {
  LESSON_ITEM_KINDS,
  LESSON_PROPOSE_MIN,
  LESSON_UNUSED_DAYS,
  type LessonScope,
  lessonKey,
} from '@forge/contracts/lessons';
import { cutAtWord } from '@forge/contracts/title-text';
import { z } from 'zod';
import { callFastModelObject } from '../integrations/llm/index.js';
import { createIssue } from '../issues/index.js';
import {
  checksOwed,
  type GatherCorrection,
  type GatherLesson,
  gatherInput,
  linkRepeats,
  type OwedCheck,
  projectsWithLessonWork,
  proposeLesson,
  type RetirementDue,
  recordCheckIssue,
  recordLessonsMonths,
  rejectCorrections,
  retireLesson,
  retirementsDue,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { stewardAccountOf } from './account.js';
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
const CHECK_TITLE_CHARS = 120;

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
        areaId: z.string().nullish(),
        itemKind: z.enum(LESSON_ITEM_KINDS).nullish(),
        corrections: z.array(z.string()),
        supersedes: z.number().int().nullish(),
      }),
    )
    .default([]),
});
export type LessonGrouping = z.infer<typeof groupingSchema>;

/** How the pass groups: the fast model through the gateway, or a test's own answer. */
export type Grouper = (
  projectId: string,
  input: { corrections: GatherCorrection[]; lessons: GatherLesson[] },
) => Promise<LessonGrouping | null>;

export function groupingPrompt(input: {
  corrections: GatherCorrection[];
  lessons: GatherLesson[];
}): string {
  return [
    "You are the project's steward. People corrected the project's agents; each correction below says what was wrong.",
    `1. Reject a correction that is not one (\`rejections\`: its \`correction\` id and a \`reason\` of one sentence under ${GROUP_REASON_CHARS} characters): it names nothing the agent did wrong, it is a test or probe, or it is a question, thanks or noise. A rejected correction never feeds a lesson. Reject only what plainly is not a correction.`,
    '2. Link a correction to an existing lesson only when it repeats that lesson (`links`: its `correction` id and the `lesson` number).',
    `3. Group the other corrections that make the same point, ${LESSON_PROPOSE_MIN} or more each, and propose one lesson per group (\`proposals\`): one imperative \`sentence\` an agent can apply, the \`corrections\` ids it came from, and a \`scope\`: \`project\`, \`area\` (with the corrections' \`areaId\`) or \`item_kind\` (with an \`itemKind\`: requirement, workflow, mockup, suggestion, issue or chat) — the narrowest that fits. Where a group replaces an approved lesson, name that lesson's number in \`supersedes\`.`,
    'Corrections on different items make the same point when one general mistake lies behind them: the same rule missed, the same kind of check skipped, the same wording or habit corrected. Say that general rule, not the item.',
    'Leave a correction alone when nothing else makes its point; it waits for a second one.',
    `Lessons:\n${input.lessons.map((l) => `- ${lessonKey(l.number)} (${l.status}, ${l.scope}): ${l.sentence}`).join('\n') || '(none)'}`,
    `Corrections:\n${markUntrusted(
      input.corrections
        .map(
          (c) =>
            `- ${c.id} [${c.source}, ${c.itemKind} ${c.itemKey}, area ${c.areaId ?? 'none'}]: ${c.reason}`,
        )
        .join('\n'),
      { source: 'the corrections people said' },
    )}`,
  ].join('\n\n');
}

export const modelGrouper: Grouper = async (projectId, input) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'corrections grouped into lessons' },
    groupingPrompt(input),
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
  for (const p of answer.proposals) {
    const corrections = [...new Set(p.corrections.filter((c) => ids.has(c)))];
    const scope = scopeOf(p);
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
      await proposeLesson({
        projectId,
        actor: { userId: stewardId, agency: 'agent' },
        body: {
          sentence: p.sentence,
          scope,
          corrections,
          ...(p.supersedes ? { supersedes: p.supersedes } : {}),
        },
      });
      for (const c of corrections) ids.delete(c);
      proposed += 1;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      dropped += 1;
      logger.warn({ projectId, err: err.message }, 'steward: a lesson proposal was refused');
    }
  }
  return { proposed, dropped };
}

function checkBody(owed: OwedCheck): string {
  return [
    `${lessonKey(owed.number)} keeps being corrected${owed.repeats > 0 ? `, ${owed.repeats} time(s) after it was approved` : ''}: "${owed.sentence}"`,
    'Turn it into a check in code so it is caught before a person sees it: a lint rule, a test, or a screen probe.',
    'The corrections it learned from:',
    ...owed.reasons.map((r) => `- ${r}`),
  ].join('\n\n');
}

async function fileChecks(projectId: string, stewardId: string): Promise<number> {
  let filed = 0;
  for (const owed of await checksOwed(projectId)) {
    const made = await createIssue(
      {
        projectId,
        title: cutAtWord(`Add a check: ${owed.sentence}`, CHECK_TITLE_CHARS),
        description: checkBody(owed),
        priority: 'medium',
        status: 'draft',
        detectorKey: `lesson-check/${owed.id}`,
      },
      {
        createdById: stewardId,
        createdByDeviceId: null,
        createdVia: 'system',
        actor: { type: 'user', id: stewardId, agency: 'agent' },
      },
    );
    const issueId = made.deduped ? made.existingIssueId : made.issue.id;
    await recordCheckIssue(owed.id, issueId);
    filed += 1;
  }
  return filed;
}

const retireWhy = (due: RetirementDue) =>
  due.reason === 'superseded'
    ? `Superseded by ${due.supersededBy ? lessonKey(due.supersededBy) : 'a newer lesson'}.`
    : `No agent applied it in ${LESSON_UNUSED_DAYS} days.`;

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

export interface LessonsPassTally extends SettleTally {
  projects: number;
  /** Corrections the steward rejected as not corrections; `rejected` counts proposals it rejected. */
  correctionsRejected: number;
  linked: number;
  proposed: number;
  /** Groups the model proposed that did not become a lesson: too few open corrections, no scope, or refused. */
  dropped: number;
  /** Projects whose corrections the model gave no readable grouping for (logged with why). */
  ungrouped: number;
  retired: number;
  checks: number;
  failed: number;
}

interface Judges {
  group: Grouper;
  review: Reviewer;
  settle: Settler;
}

async function passProject(projectId: string, now: Date, judges: Judges, tally: LessonsPassTally) {
  const { group } = judges;
  const stewardId = await stewardAccountOf(projectId);
  const input = await gatherInput(projectId);
  if (input.corrections.length > 0) {
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
    } else {
      tally.ungrouped += 1;
    }
  }
  await settleLessons(projectId, stewardId, judges, tally);
  tally.retired += await retireDue(projectId, stewardId, now);
  tally.checks += await fileChecks(projectId, stewardId);
  await recordLessonsMonths(projectId, now);
}

/** One pass over every project with lesson work whose steward is on. */
export async function runLessonsPass(
  opts: {
    now?: Date;
    group?: Grouper;
    review?: Reviewer;
    settle?: Settler;
    projectIds?: readonly string[];
  } = {},
): Promise<LessonsPassTally> {
  const now = opts.now ?? new Date();
  const judges: Judges = {
    group: opts.group ?? modelGrouper,
    review: opts.review ?? modelReviewer,
    settle: opts.settle ?? modelSettler,
  };
  const tally: LessonsPassTally = {
    projects: 0,
    correctionsRejected: 0,
    linked: 0,
    proposed: 0,
    dropped: 0,
    ungrouped: 0,
    approved: 0,
    rejected: 0,
    settled: 0,
    waiting: 0,
    retired: 0,
    checks: 0,
    failed: 0,
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
