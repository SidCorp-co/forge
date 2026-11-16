/**
 * The lessons map every agent's prompt carries (REQ-50 BC-3, BC-4, BC-5; owner rule prompt-is-a-map,
 * 2026-11-01; ISS-1251): one line per approved lesson in its scope, saying WHEN it applies and its
 * gist, so an agent knows which to open in full; never the whole sentence. An agent reads the ones its
 * work needs by retrieval, from project knowledge (`knowledge/lesson-entries.ts`), so a held, rejected
 * or proposed lesson is never named here. The map has a hard character budget,
 * `LESSONS_MAP_MAX_CHARS`, and past it the map merges rather than cuts (ISS-1251): every lesson is
 * named by its slug under the situation it applies in, the nearest given their gist as the budget
 * allows; where even the slugs do not fit, the farthest situations are said as a count, and past
 * that folded into one count with the door that lists them, so a project with five hundred lessons
 * costs every prompt what one with five does. A lesson the map could only count is a pile the
 * steward folds (`lessonsMapOverflow`).
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
const GIST_MAX = 72;

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

/** A lesson's line under the heading that says when it applies: the slug to open, and its gist. */
const lineOf = (e: LessonEntry) => `- ${e.slug}: ${gistOf(e.sentence)}`;

/** The heading over the lessons that apply in one situation, said once for all of them. */
const headingOf = (e: LessonEntry) => `When ${whenOf(e)}:`;

/**
 * Whether a composed text's map named this lesson, with its gist or among its situation's slugs
 * (`prompt/carried.ts` records what reached a run).
 */
export const lessonNamedIn = (text: string, slug: string) =>
  new RegExp(`(^|\\n)(- ${slug}: |- also (?:[^\\n]*, )?${slug}(?:,|\\n|$))`).test(text);

/** The narrower a lesson's scope, the likelier it governs this work; the newest first within one. */
const SCOPE_RANK = { area: 0, item_kind: 1, project: 2 } as const;
const byReach = (a: LessonEntry, b: LessonEntry) =>
  SCOPE_RANK[a.meta.scope.kind] - SCOPE_RANK[b.meta.scope.kind] || b.meta.number - a.meta.number;

/** The lessons in reach order, gathered under their situation's heading where its first one falls. */
function grouped(reach: readonly LessonEntry[]): LessonEntry[][] {
  const groups = new Map<string, LessonEntry[]>();
  for (const e of reach) {
    const key = headingOf(e);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()];
}

/**
 * How one situation is said: its first `named` lessons by slug, the first `gists` of them with their
 * gist, and the rest counted under it; a situation naming none is only counted, or folded into the
 * map's closing count.
 */
type Said = { named: number; gists: number } | 'counted' | 'folded';

/** One situation as the map says it. */
function groupLines(group: readonly LessonEntry[], said: Said): string[] {
  const heading = headingOf(group[0] as LessonEntry);
  if (said === 'folded') return [];
  const count = (n: number) => `${n} ${n === 1 ? 'lesson' : 'lessons'}`;
  if (said === 'counted') return [`${heading.slice(0, -1)}: ${count(group.length)}`];
  const slugs = group.slice(said.gists, said.named).map((e) => e.slug);
  const rest = group.length - said.named;
  return [
    heading,
    ...group.slice(0, said.gists).map(lineOf),
    ...(slugs.length > 0 ? [`- also ${slugs.join(', ')}`] : []),
    ...(rest > 0 ? [`- and ${rest} more`] : []),
  ];
}

/** The map's index: each situation as said, and the list door where any lesson is not named. */
function indexOf(
  groups: readonly LessonEntry[][],
  said: readonly Said[],
  audience: LessonAudience,
) {
  const folded = groups.reduce((n, g, i) => n + (said[i] === 'folded' ? g.length : 0), 0);
  const unnamed = groups.some((g, i) => {
    const s = said[i] as Said;
    return typeof s === 'string' || s.named < g.length;
  });
  const closing =
    folded > 0 ? moreLine(folded, audience) : unnamed ? `Every lesson: ${audience.list}` : '';
  return [...groups.flatMap((g, i) => groupLines(g, said[i] as Said)), closing]
    .filter(Boolean)
    .join('\n');
}

/** The map's text, or null where no lesson reaches this audience. Never longer than the budget. */
export function lessonsMapText(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
  depth: 2 | 3,
): string | null {
  const groups = grouped(lessonsFor(entries, audience).sort(byReach));
  if (groups.length === 0) return null;
  // the frame is said in as few words as carry the three doors, so the budget goes to the lessons
  const head = [
    `${'#'.repeat(depth)} Lessons`,
    `Read first each that fits your work: ${audience.fetch}.`,
  ].join('\n');
  const tail = `End with \`Lessons applied: L-3, L-7\`. Raise one that conflicts or cannot apply (${audience.raise}) and go on without it.`;
  const textOf = (said: readonly Said[]) =>
    `${head}\n\n${indexOf(groups, said, audience)}\n\n${tail}`;
  const said: Said[] = groups.map(() => 'folded');
  /** Takes `next` for situation `i` where the map still fits its budget with it. */
  const tried = (i: number, next: Said) => {
    const was = said[i] as Said;
    said[i] = next;
    if (textOf(said).length <= LESSONS_MAP_MAX_CHARS) return true;
    said[i] = was;
    return false;
  };
  // the map merges, never cuts (ISS-1251): each lesson is named by slug in reach order while the
  // budget holds, the situations left are counted, and those that no count fits are folded into one
  const at = (i: number) => said[i] as { named: number; gists: number };
  named: for (const [i, group] of groups.entries()) {
    for (let n = 1; n <= group.length; n += 1) {
      if (!tried(i, { named: n, gists: 0 })) break named;
    }
  }
  for (const i of groups.keys()) if (said[i] === 'folded' && !tried(i, 'counted')) break;
  // every lesson named, the nearest are given their gist, in reach order, while the budget holds
  if (groups.every((g, i) => typeof said[i] !== 'string' && at(i).named === g.length)) {
    gists: for (const [i, group] of groups.entries()) {
      for (let k = 1; k <= group.length; k += 1) {
        if (!tried(i, { named: group.length, gists: k })) break gists;
      }
    }
  }
  const text = textOf(said);
  if (text.length > LESSONS_MAP_MAX_CHARS) {
    throw new Error(
      `lessons: the map for this audience takes ${text.length} characters, over its budget of ${LESSONS_MAP_MAX_CHARS}: its fetch, list or raise door is too long`,
    );
  }
  return text;
}

/** The count of the lessons the map folded, and where to list them; empty where it folded none. */
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
): { reach: number; named: number; size: number; cap: number } {
  const text = lessonsMapText(entries, audience, 2) ?? '';
  const reach = lessonsFor(entries, audience).length;
  const named = lessonsFor(entries, audience).filter((e) => lessonNamedIn(text, e.slug)).length;
  return { reach, named, size: text.length, cap: LESSONS_MAP_MAX_CHARS };
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
    // the project's path is spelled once, in the read door the map's first line names; the others
    // say `…` for it
    fetch: `\`GET /api/projects/${projectId}/knowledge/<slug>\`, by topic \`POST …/knowledge/search\``,
    list: `\`GET …/knowledge?kind=lesson&injection=on_demand\``,
    raise: `\`POST …/lessons/<n>/confusions\`; applied: \`POST …/lessons/applied\``,
  }) as const;
