/**
 * The lessons map every agent's prompt carries (REQ-50 BC-3, BC-4, BC-5; owner rule prompt-is-a-map,
 * 2026-11-01; ISS-1251): one line per approved lesson in its scope, saying WHEN it applies and its
 * gist, so an agent knows which to open in full; never the whole sentence. An agent reads the ones its
 * work needs by retrieval, from project knowledge (`knowledge/lesson-entries.ts`), so a held, rejected
 * or proposed lesson is never named here. The map has a character cap, `LESSONS_MAP_MAX_CHARS`, and
 * nothing is cut to meet it (ISS-1251 c5): every lesson is named by its slug under the situation it
 * applies in, the nearest given their gist as the cap allows, and a map whose slugs alone run past it
 * is served whole and says so, from which lesson on, until the steward's merge brings it back under
 * (`lessonsMapOverflow`, `steward/lessons-piles.ts`).
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
  /** How this agent lists every lesson, named where the map runs past its cap. */
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

/** How one situation is said: every lesson by slug, the first `gists` of them with their gist. */
function groupLines(group: readonly LessonEntry[], gists: number): string[] {
  const slugs = group.slice(gists).map((e) => e.slug);
  return [
    headingOf(group[0] as LessonEntry),
    ...group.slice(0, gists).map(lineOf),
    ...(slugs.length > 0 ? [`- also ${slugs.join(', ')}`] : []),
  ];
}

/**
 * The line a map past its cap carries: how far past, from which lesson on, and that a merge is owed.
 * Nothing is cut to fit (ISS-1251 c5): until the steward's merge lands, what runs past the cap is
 * served and said, so neither the agent nor the Budgets panel reads it as fitting.
 */
export const pastCapLine = (size: number, from: string, count: number, list: string) =>
  `Past its ${LESSONS_MAP_MAX_CHARS}-character cap: this map is ${size} characters, from ${from} on (${count} ${count === 1 ? 'lesson' : 'lessons'}), served whole until the steward's merge lands; every lesson: ${list}`;

/** The lessons whose name the map ends past `at` characters, in the order it names them. */
function namedPast(text: string, at: number, reach: readonly LessonEntry[]): LessonEntry[] {
  const index = (e: LessonEntry) =>
    text.search(new RegExp(`(?<=- |- also |, )${e.slug}(?=[:,\\n]|$)`));
  return reach
    .map((e) => ({ e, i: index(e) }))
    .filter((x) => x.i >= 0 && x.i + x.e.slug.length > at)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.e);
}

/** The map as composed, and the lessons it names past its cap (none where it fits). */
function composeMap(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
  depth: 2 | 3,
): { text: string; past: LessonEntry[] } | null {
  const reach = lessonsFor(entries, audience).sort(byReach);
  const groups = grouped(reach);
  if (groups.length === 0) return null;
  // the frame is said in as few words as carry the three doors, so the budget goes to the lessons
  const head = [
    `${'#'.repeat(depth)} Lessons`,
    `Read first each that fits your work: ${audience.fetch}.`,
  ].join('\n');
  const tail = `End with \`Lessons applied: L-3, L-7\`. Raise one that conflicts or cannot apply (${audience.raise}) and go on without it.`;
  const textOf = (gists: readonly number[], past = '') =>
    `${head}\n\n${groups.flatMap((g, i) => groupLines(g, gists[i] ?? 0)).join('\n')}${past ? `\n${past}` : ''}\n\n${tail}`;
  const gists = groups.map(() => 0);
  // the nearest are given their gist, in reach order, while the cap holds
  fill: for (const [i, group] of groups.entries()) {
    for (let k = 1; k <= group.length; k += 1) {
      gists[i] = k;
      if (textOf(gists).length > LESSONS_MAP_MAX_CHARS) {
        gists[i] = k - 1;
        break fill;
      }
    }
  }
  const text = textOf(gists);
  if (text.length <= LESSONS_MAP_MAX_CHARS) return { text, past: [] };
  const past = namedPast(text, LESSONS_MAP_MAX_CHARS - tail.length - 2, reach);
  const first = past[0]?.slug ?? reach.at(-1)?.slug ?? '';
  const draft = textOf(gists, pastCapLine(text.length, first, past.length, audience.list));
  return {
    text: textOf(gists, pastCapLine(draft.length, first, past.length, audience.list)),
    past,
  };
}

/**
 * The map's text, or null where no lesson reaches this audience. Every lesson is named, by slug under
 * the situation it applies in, the nearest with their gist as the cap allows; a map whose slugs alone
 * run past the cap is served whole and says from which lesson on it does, never cut (ISS-1251 c5).
 */
export const lessonsMapText = (
  entries: readonly LessonEntry[],
  audience: LessonAudience,
  depth: 2 | 3,
): string | null => composeMap(entries, audience, depth)?.text ?? null;

/**
 * The map against its cap for one audience: every lesson reaching it is named, and a map past its cap
 * is a pile the steward merges (ISS-1251), never a line the map cuts.
 */
export function lessonsMapOverflow(
  entries: readonly LessonEntry[],
  audience: LessonAudience,
): { reach: number; named: number; size: number; cap: number; past: string[] } {
  const map = composeMap(entries, audience, 2);
  const text = map?.text ?? '';
  const reach = lessonsFor(entries, audience);
  return {
    reach: reach.length,
    named: reach.filter((e) => lessonNamedIn(text, e.slug)).length,
    size: text.length,
    cap: LESSONS_MAP_MAX_CHARS,
    past: (map?.past ?? []).map((e) => e.slug),
  };
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
