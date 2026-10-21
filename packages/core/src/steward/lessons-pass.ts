// The steward's lessons pass (REQ-50 BC-2, BC-6, BC-7; docs/proposals/lessons.md): every
// `LESSONS_PASS_MS`, in each project whose steward is on, it asks the fast model to link each new
// correction to the lesson it repeats and to group the rest, and proposes each group of
// `LESSON_PROPOSE_MIN` or more as a lesson authored by the steward account. It then proposes
// retirements and files each owed check as a draft issue. A proposal is a proposal: nothing reaches a
// prompt until a person approves it.

import {
  LESSON_ITEM_KINDS,
  LESSON_PROPOSE_MIN,
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
  proposeRetirements,
  recordCheckIssue,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { stewardAccountOf } from './account.js';
import { stewardStanceOf } from './policy.js';

const GROUP_MAX_TOKENS = 1500;
const CHECK_TITLE_CHARS = 120;

const grouping = z.object({
  links: z.array(z.object({ correction: z.string(), lesson: z.number().int() })),
  proposals: z.array(
    z.object({
      sentence: z.string().min(1).max(240),
      scope: z.enum(['project', 'area', 'item_kind']),
      areaId: z.string().nullable(),
      itemKind: z.enum(LESSON_ITEM_KINDS).nullable(),
      corrections: z.array(z.string()),
    }),
  ),
});
export type LessonGrouping = z.infer<typeof grouping>;

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
    '1. Link a correction to an existing lesson only when it repeats that lesson (`links`).',
    `2. Group the other corrections that make the same point, ${LESSON_PROPOSE_MIN} or more each, and propose one lesson per group (\`proposals\`): one imperative sentence an agent can apply, and a scope: \`project\`, \`area\` (with the corrections' areaId) or \`item_kind\` (requirement, workflow, mockup, suggestion, issue or chat) — the narrowest that fits.`,
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
    grouping,
    { maxTokens: GROUP_MAX_TOKENS },
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
  for (const p of answer.proposals) {
    const corrections = [...new Set(p.corrections.filter((c) => ids.has(c)))];
    const scope = scopeOf(p);
    if (corrections.length < LESSON_PROPOSE_MIN || !scope) continue;
    try {
      await proposeLesson({
        projectId,
        actor: { userId: stewardId, agency: 'agent' },
        body: { sentence: p.sentence, scope, corrections },
      });
      for (const c of corrections) ids.delete(c);
      proposed += 1;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      logger.warn({ projectId, err: err.message }, 'steward: a lesson proposal was refused');
    }
  }
  return proposed;
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

export interface LessonsPassTally {
  projects: number;
  linked: number;
  proposed: number;
  retirements: number;
  checks: number;
  failed: number;
}

async function passProject(projectId: string, now: Date, group: Grouper, tally: LessonsPassTally) {
  const stewardId = await stewardAccountOf(projectId);
  const input = await gatherInput(projectId);
  if (input.corrections.length > 0) {
    const answer = await group(projectId, input);
    if (answer) {
      const ids = new Set(input.corrections.map((c) => c.id));
      const links = answer.links.filter((l) => ids.has(l.correction));
      tally.linked += await linkRepeats(projectId, links);
      for (const l of links) ids.delete(l.correction);
      tally.proposed += await proposeGroups(projectId, stewardId, ids, answer);
    }
  }
  tally.retirements += await proposeRetirements(projectId, now);
  tally.checks += await fileChecks(projectId, stewardId);
}

/** One pass over every project with lesson work whose steward is on. */
export async function runLessonsPass(
  opts: { now?: Date; group?: Grouper; projectIds?: readonly string[] } = {},
): Promise<LessonsPassTally> {
  const now = opts.now ?? new Date();
  const group = opts.group ?? modelGrouper;
  const tally: LessonsPassTally = {
    projects: 0,
    linked: 0,
    proposed: 0,
    retirements: 0,
    checks: 0,
    failed: 0,
  };
  for (const projectId of opts.projectIds ?? (await projectsWithLessonWork())) {
    if (!(await stewardStanceOf(projectId)).enabled) continue;
    tally.projects += 1;
    try {
      await passProject(projectId, now, group, tally);
    } catch (err) {
      // one project's failure is named and counted; the other projects still get their pass
      tally.failed += 1;
      logger.error({ err, projectId }, 'steward: the lessons pass failed on a project');
    }
  }
  return tally;
}
