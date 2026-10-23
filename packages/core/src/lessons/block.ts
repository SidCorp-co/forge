/**
 * The "Lessons" block every agent's prompt carries (REQ-50 BC-3, BC-4, BC-5): the approved lessons
 * in its scope, read from project knowledge (`knowledge/lesson-entries.ts`), so a held, rejected or
 * proposed lesson is never in it. It tells the agent how to list what it applied and to stop and
 * report a confusion to the steward rather than guess.
 */

import { type LessonItemKind, lessonKey } from '@forge/contracts/lessons';
import { type LessonEntry, selectLessonEntries } from '../knowledge/index.js';

const KIND_LABEL: Record<LessonItemKind, string> = {
  requirement: 'requirements',
  workflow: 'workflow designs',
  mockup: 'mockups',
  suggestion: 'suggestions',
  issue: 'issues and code',
  chat: 'chat replies',
};

export interface LessonAudience {
  /** The kinds of output this agent produces; an `item_kind` lesson reaches it only for these. */
  produces: readonly LessonItemKind[];
  /** Its subject's area; `any` where it works with no one subject, and every area lesson is shown
   *  labelled with the area it is for. */
  area: string | null | 'any';
  /** How this agent raises a confusion: a door or a tool it holds. */
  raise: string;
}

/** The lessons of one project that reach this audience. */
export function lessonsFor(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
): LessonEntry[] {
  return entries.filter(({ meta: { scope } }) => {
    if (scope.kind === 'project') return true;
    if (scope.kind === 'item_kind') {
      return audience.produces.includes(scope.itemKind as LessonItemKind);
    }
    return audience.area === 'any' || (audience.area !== null && audience.area === scope.areaId);
  });
}

function scopeLabel(entry: LessonEntry): string {
  const { scope } = entry.meta;
  if (scope.kind === 'project') return 'all work';
  if (scope.kind === 'item_kind') {
    return KIND_LABEL[scope.itemKind as LessonItemKind] ?? scope.itemKind ?? 'one kind of work';
  }
  return `only work in the area ${scope.areaName ?? scope.areaId}`;
}

/** The block's text, or null where no lesson reaches this audience. */
export function lessonsBlockText(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
  depth: 2 | 3,
): string | null {
  const reach = lessonsFor(entries, audience);
  if (reach.length === 0) return null;
  const heading = '#'.repeat(depth);
  return [
    `${heading} Lessons (learned from corrections, approved by the steward)`,
    "Each lesson was learned from corrections made to this project's work and approved by its steward. Apply every lesson that fits what you are producing now.",
    reach.map((e) => `- ${lessonKey(e.meta.number)} [${scopeLabel(e)}]: ${e.sentence}`).join('\n'),
    'When a lesson shaped your output, end the output with one line naming them: `Lessons applied: L-3, L-7`.',
    `If two lessons conflict, a lesson contradicts a requirement or design, you cannot tell how one applies, or you find one wrongly applied to an output: stop guessing, do not apply it, and report it to the steward as a confusion with both sides and the resolution you recommend (${audience.raise}). Then go on without that lesson; it is held until the steward settles it, and no person is asked.`,
  ].join('\n\n');
}

/** The block for one project and audience, read now. */
export async function lessonsBlockFor(
  projectId: string,
  audience: LessonAudience,
  depth: 2 | 3,
): Promise<string | null> {
  return lessonsBlockText(await selectLessonEntries(projectId), audience, depth);
}

/** How a run, a master or any agent holding a project credential reports a confusion. */
export const RAISE_BY_DOOR =
  '`POST /api/projects/<projectId>/lessons/<n>/confusions` with `{ kind: conflict | contradicts | unclear | wrongly_applied, other?: { lesson?, ref? }, sides: { lesson, other }, recommended: { resolution: keep | edit | retire, sentence? } }`, a wrongly_applied naming its output in other.ref; record what you applied with `POST /api/projects/<projectId>/lessons/applied`';
