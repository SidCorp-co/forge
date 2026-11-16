/**
 * The lessons map every agent's prompt carries (REQ-50 BC-3, BC-4, BC-5; owner rule prompt-is-a-map,
 * 2026-11-01; ISS-1251): one line per approved lesson in its scope, saying WHEN it applies and its
 * gist, so an agent knows which to open in full; never the whole sentence. An agent reads the ones its
 * work needs by retrieval, from project knowledge (`knowledge/lesson-entries.ts`), so a held, rejected
 * or proposed lesson is never named here. The map has a hard character budget,
 * `LESSONS_MAP_MAX_CHARS`: the lessons nearest this agent's work come first, and past the budget the
 * rest are counted and the door that lists them is named, so a project with five hundred lessons costs
 * every prompt what one with five does. A map that cannot name them all is a pile the steward folds
 * (`lessonsMapOverflow`), never a reason to cut a line.
 */

import type { LessonItemKind } from '@forge/contracts/lessons';
import { type LessonEntry, selectLessonEntries } from '../knowledge/index.js';

/** The most characters the map takes in any prompt, whatever the lessons and the audience. */
export const LESSONS_MAP_MAX_CHARS = 1200;

/** A scope label longer than this (an area's own name) is cut, so one lesson cannot fill the map. */
const LABEL_MAX = 40;

const KIND_LABEL: Record<LessonItemKind, string> = {
  requirement: 'requirements',
  workflow: 'workflow designs',
  mockup: 'mockups',
  suggestion: 'suggestions',
  issue: 'issues and code',
  chat: 'chat replies',
};

/** The most characters of a lesson's first sentence a map line carries. */
const GIST_MAX = 90;

export interface LessonAudience {
  /** The kinds of output this agent produces; an `item_kind` lesson reaches it only for these. */
  produces: readonly LessonItemKind[];
  /** Its subject's area; `any` where it works with no one subject, and every area lesson is named
   *  labelled with the area it is for. */
  area: string | null | 'any';
  /** How this agent reads one lesson by its slug and finds the ones its work needs: a door or a tool
   *  it holds. Short: it is said in every prompt. */
  fetch: string;
  /** How this agent lists every lesson, named only where the map could not hold them all. */
  list: string;
  /** How this agent raises a confusion: a door or a tool it holds. Short, for the same reason. */
  raise: string;
}

/** The lessons of one project that reach this audience. */
export function lessonsFor(
  entries: readonly LessonEntry[],
  audience: Pick<LessonAudience, 'produces' | 'area'>,
): LessonEntry[] {
  return entries.filter(({ meta: { scope } }) => {
    if (scope.kind === 'project') return true;
    if (scope.kind === 'item_kind') {
      return audience.produces.includes(scope.itemKind as LessonItemKind);
    }
    return audience.area === 'any' || (audience.area !== null && audience.area === scope.areaId);
  });
}

const cut = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/** When a lesson applies, in the situation an agent is in: its scope, said as the work it governs. */
function whenOf(entry: LessonEntry): string {
  const { scope } = entry.meta;
  if (scope.kind === 'project') return 'any work';
  if (scope.kind === 'item_kind') {
    return `writing ${KIND_LABEL[scope.itemKind as LessonItemKind] ?? cut(scope.itemKind ?? 'one kind of work')}`;
  }
  return `working in ${cut(scope.areaName ?? scope.areaId ?? '?')}`;
}

/** The lesson's first sentence, cut at a word to `GIST_MAX`: what it says, short enough to choose by. */
export function gistOf(sentence: string): string {
  const first = (sentence.trim().split(/(?<=[.!?])\s/)[0] ?? '').replace(/\s+/g, ' ');
  if (first.length <= GIST_MAX) return first;
  const cutAt = first.lastIndexOf(' ', GIST_MAX - 1);
  return `${first.slice(0, cutAt > 20 ? cutAt : GIST_MAX - 1)}…`;
}

/** One map line: the slug to open, when it applies, and its gist. */
const lineOf = (e: LessonEntry) => `${e.slug}, when ${whenOf(e)}: ${gistOf(e.sentence)}`;

/** Whether a composed text's map named this lesson (`prompt/carried.ts` records what reached a run). */
export const lessonNamedIn = (text: string, slug: string) =>
  new RegExp(`(^|\\n)${slug}, when `).test(text);

/** The narrower a lesson's scope, the likelier it governs this work; the newest first within one. */
const SCOPE_RANK = { area: 0, item_kind: 1, project: 2 } as const;
const byReach = (a: LessonEntry, b: LessonEntry) =>
  SCOPE_RANK[a.meta.scope.kind] - SCOPE_RANK[b.meta.scope.kind] || b.meta.number - a.meta.number;

/** The map's text, or null where no lesson reaches this audience. Never longer than the budget. */
export function lessonsMapText(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
  depth: 2 | 3,
): string | null {
  const reach = lessonsFor(entries, audience).sort(byReach);
  if (reach.length === 0) return null;
  const head = [
    `${'#'.repeat(depth)} Lessons (read the ones your work needs)`,
    `Learned from corrections to this project's work. Each line says when one applies; before you produce work, read in full each one that fits it with ${audience.fetch}.`,
  ].join('\n');
  const tail = `End the output a lesson shaped with \`Lessons applied: L-3, L-7\`. A lesson that conflicts with another or with a requirement, or that you cannot apply: report a confusion (${audience.raise}) and go on without it; it is held until the steward settles it.`;
  // the map's frame, then as many lines as fit beside the line that counts the rest
  const frame = head.length + tail.length + 4;
  const items = reach.map(lineOf);
  let shown = 0;
  let listed = 0;
  for (const item of items) {
    const next = listed + (shown > 0 ? 1 : 0) + item.length;
    if (frame + next + moreLine(items.length - shown - 1, audience).length > LESSONS_MAP_MAX_CHARS)
      break;
    listed = next;
    shown += 1;
  }
  const index = [...items.slice(0, shown), moreLine(items.length - shown, audience)]
    .filter(Boolean)
    .join('\n');
  const text = `${head}\n\n${index}\n\n${tail}`;
  if (text.length > LESSONS_MAP_MAX_CHARS) {
    throw new Error(
      `lessons: the map for this audience takes ${text.length} characters, over its budget of ${LESSONS_MAP_MAX_CHARS}: its fetch, list or raise door is too long`,
    );
  }
  return text;
}

/** The count of the lessons the map could not name, and where to list them; empty where it named all. */
function moreLine(rest: number, audience: LessonAudience): string {
  if (rest <= 0) return '';
  return `${rest} more ${rest === 1 ? 'lesson' : 'lessons'}, nearer other work: ${audience.list}`;
}

/**
 * How many of the lessons reaching this audience its map could not name: a pile the steward folds
 * into the teaching each one is about (ISS-1251), never a line the map cuts. 0 where all fit.
 */
export function lessonsMapOverflow(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
): { reach: number; named: number; size: number } {
  const text = lessonsMapText(entries, audience, 2) ?? '';
  const reach = lessonsFor(entries, audience).length;
  const named = lessonsFor(entries, audience).filter((e) => lessonNamedIn(text, e.slug)).length;
  return { reach, named, size: text.length };
}

/** The map for one project and audience, read now. */
export async function lessonsMapFor(
  projectId: string,
  audience: LessonAudience,
  depth: 2 | 3,
): Promise<string | null> {
  return lessonsMapText(await selectLessonEntries(projectId), audience, depth);
}

/** How a run, a master or any agent holding a project credential reads, lists and raises. */
export const restLessonDoors = (projectId: string) =>
  ({
    fetch: `\`GET /api/projects/${projectId}/knowledge/<slug>\`, or find them by topic with \`POST /api/projects/${projectId}/knowledge/search {"query": <your task>}\``,
    list: `\`GET /api/projects/${projectId}/knowledge?kind=lesson&injection=on_demand\``,
    raise: `\`POST /api/projects/${projectId}/lessons/<n>/confusions\`; record what you applied with \`POST /api/projects/${projectId}/lessons/applied\``,
  }) as const;
