import { describe, expect, it } from 'vitest';
import type { LessonEntry } from '../knowledge/index.js';
import {
  gistOf,
  LESSONS_MAP_MAX_CHARS,
  type LessonAudience,
  lessonNamedIn,
  lessonsFor,
  lessonsMapOverflow,
  lessonsMapText,
  restLessonDoors,
} from './block.js';

const entry = (number: number, scope: LessonEntry['meta']['scope']): LessonEntry => ({
  slug: `lesson-${number}`,
  sentence: `Said once as rule ${number}.`,
  meta: { lessonId: `id-${number}`, number, scope },
});
const project = entry(1, { kind: 'project', areaId: null, areaName: null, itemKind: null });
const billing = entry(2, { kind: 'area', areaId: 'a-1', areaName: 'Billing', itemKind: null });
const reqs = entry(3, { kind: 'item_kind', areaId: null, areaName: null, itemKind: 'requirement' });
const all = [project, billing, reqs];
const numbers = (e: LessonEntry[]) => e.map((x) => x.meta.number);
const doors = { fetch: 'the read door', list: 'the list door', raise: 'the raise door' };
const aud = (a: Pick<LessonAudience, 'produces' | 'area'>): LessonAudience => ({ ...a, ...doors });

/** The lessons a map names by slug, with its gist or among its situation's slugs. */
const namedIn = (text: string) =>
  new Set([...text.matchAll(/\blesson-\d+\b/g)].map((m) => m[0])).size;

/** The line a map past its cap carries, read back: its size, the lesson it runs past from, how many. */
const PAST =
  /^Past its 1200-character cap: this map is (\d+) characters, from (lesson-\d+) on \((\d+) lessons?\), served whole until the steward's merge lands; every lesson: (.+)$/m;

describe('which lessons reach an agent (REQ-50 BC-3)', () => {
  it('a project lesson reaches everyone; a kind lesson only an agent producing that kind', () => {
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: null }))).toEqual([1]);
    expect(numbers(lessonsFor(all, { produces: ['requirement'], area: null }))).toEqual([1, 3]);
  });

  it("an area lesson reaches only its area's work, or every agent with no one subject", () => {
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'a-1' }))).toEqual([1, 2]);
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'a-2' }))).toEqual([1]);
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'any' }))).toEqual([1, 2]);
  });
});

describe('a prompt carries a map of the lessons, never their sentences (ISS-867, prompt-is-a-map)', () => {
  it('renders nothing where no lesson reaches', () => {
    expect(lessonsMapText([reqs], aud({ produces: ['issue'], area: null }), 2)).toBeNull();
  });

  it('says for each lesson when it applies and its gist, and how to read, apply and raise', () => {
    const text = lessonsMapText(all, aud({ produces: ['requirement'], area: 'any' }), 3) ?? '';
    expect(text).toContain('### Lessons');
    expect(text).toContain(
      [
        'When working in Billing:',
        '- lesson-2: Said once as rule 2.',
        'When writing requirements:',
        '- lesson-3: Said once as rule 3.',
        'When any work:',
        '- lesson-1: Said once as rule 1.',
      ].join('\n'),
    );
    expect(text).toContain('the read door');
    expect(text).toContain('Lessons applied: L-3, L-7');
    expect(text).toContain('(the raise door)');
    expect(text).not.toContain('the list door');
    expect(lessonNamedIn(text, 'lesson-2')).toBe(true);
    expect(lessonNamedIn(text, 'lesson-20')).toBe(false);
  });

  it('cuts a long first sentence at a word, and carries only the first sentence', () => {
    expect(gistOf('Keep it short. Then more.')).toBe('Keep it short.');
    const long = `${'word '.repeat(40)}end.`;
    const gist = gistOf(long);
    expect(gist.length).toBeLessThanOrEqual(72);
    expect(gist.endsWith('word…')).toBe(true);
  });

  it('names all five hundred lessons past the cap, never cutting one, and says from which on it runs past (ISS-1251 c5)', () => {
    // ten to an area, its name too long for a label: every lesson is named, the nearest with their
    // gist, and the map says how far past its cap it runs and from which lesson, with the list door
    const many = Array.from({ length: 500 }, (_, i) =>
      entry(i + 1, {
        kind: 'area',
        areaId: `a-${Math.floor(i / 10)}`,
        areaName: `${Math.floor(i / 10)} is an area whose name runs well past any label it could fit`,
        itemKind: null,
      }),
    );
    for (const doorsOf of [doors, restLessonDoors('0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11')]) {
      const at = { produces: ['issue'], area: 'any', ...doorsOf } as LessonAudience;
      const text = lessonsMapText(many, at, 2) ?? '';
      expect(namedIn(text)).toBe(500);
      expect(text).not.toMatch(/\bmore\b/);
      expect(text).toMatch(/^When working in 49 is an area[^\n]*…:\n- (?:also )?lesson-500[:,]/m); // newest first
      const [, size, from, count, list] = PAST.exec(text) ?? [];
      expect(Number(size)).toBe(text.length);
      expect(list).toBe(doorsOf.list);
      const map = lessonsMapOverflow(many, at);
      expect(map).toMatchObject({
        reach: 500,
        named: 500,
        size: text.length,
        cap: LESSONS_MAP_MAX_CHARS,
      });
      expect(map.past[0]).toBe(from);
      expect(map.past).toHaveLength(Number(count));
      // what is past the cap is exactly what the map names after its first 1200 characters' lessons
      const firstAt = text.search(new RegExp(`(?<=- |- also |, )${from}(?=[:,\\n]|$)`));
      expect(firstAt).toBeGreaterThan(0);
      expect(map.past).not.toContain('lesson-500');
    }
  });

  it("names every lesson of a real project's size, its frame taking little of the budget (ISS-1251)", () => {
    // forge-dev 2026-11-16: forge's run map named 1 of 82 lessons, its frame taking most of the 1200;
    // at dev.709 it named 34 and cut the rest to "and 45 more"
    const sentence = (n: number) =>
      `Keep each owed action consistent across attention counts, home summaries and lists, rule ${n}.`;
    const areas = ['Chat and assistant', 'Screens and copy', 'Delivery'];
    const real = Array.from({ length: 82 }, (_, i) => ({
      ...entry(i + 1, {
        kind: 'area',
        areaId: `a-${i % 3}`,
        areaName: areas[i % 3] ?? null,
        itemKind: null,
      }),
      sentence: sentence(i + 1),
    }));
    const doorsOf = restLessonDoors('d1bb4907-74d9-4228-85ff-76121523af7d');
    const at = { produces: ['issue'], area: 'any', ...doorsOf } as LessonAudience;
    const map = lessonsMapOverflow(real, at);
    expect(map.named).toBe(82);
    const text = lessonsMapText(real, at, 2) ?? '';
    // the project's path is spelled once, never once per door
    expect(text.split('d1bb4907-74d9-4228-85ff-76121523af7d').length - 1).toBe(1);
    expect(text).not.toMatch(/- and \d+ more/);
    // over its cap, it says so and names from which lesson; within it, it says nothing of the kind
    expect(PAST.test(text)).toBe(map.size > LESSONS_MAP_MAX_CHARS);
    expect(map.past.length > 0).toBe(map.size > LESSONS_MAP_MAX_CHARS);
  });

  it('serves a map within its cap with nothing past it, and a door too long for it whole, saying so', () => {
    const frame = lessonsMapText([project], aud({ produces: [], area: null }), 2) ?? '';
    expect(frame).toContain('When any work:\n- lesson-1: ');
    expect(frame).not.toMatch(PAST);
    expect(lessonsMapOverflow([project], aud({ produces: [], area: null })).past).toEqual([]);
    // forge-dev 2026-11-16: a map one character over threw and took down GET /devices/me/runners
    const wide = { produces: [], area: null, ...doors, raise: 'r'.repeat(LESSONS_MAP_MAX_CHARS) };
    const text = lessonsMapText([project], wide, 2) ?? '';
    expect(lessonNamedIn(text, 'lesson-1')).toBe(true);
    expect(PAST.exec(text)?.slice(2, 4)).toEqual(['lesson-1', '1']);
  });

  it('names every lesson at every length of its frame, and says it is past its cap exactly when it is', () => {
    // sixty lessons in three situations: as the read door grows, gists give way to slugs, and past the
    // cap the map carries the line naming from which lesson on, never a count in place of a lesson
    const many = Array.from({ length: 60 }, (_, i) =>
      entry(i + 1, {
        kind: 'area',
        areaId: `a-${i % 3}`,
        areaName: `Area ${i % 3}`,
        itemKind: null,
      }),
    );
    const seen = new Set<string>();
    for (let pad = 0; pad <= 900; pad += 3) {
      const at = {
        produces: [],
        area: 'any' as const,
        ...doors,
        fetch: `the read door${'f'.repeat(pad)}`,
      };
      const text = lessonsMapText(many, at, 2) ?? '';
      expect(namedIn(text), `fetch door padded by ${pad}`).toBe(60);
      const past = lessonsMapOverflow(many, at).past;
      const over = text.length > LESSONS_MAP_MAX_CHARS;
      expect(PAST.test(text), `fetch door padded by ${pad}`).toBe(over);
      expect(past.length > 0, `fetch door padded by ${pad}`).toBe(over);
      seen.add(over ? 'past' : 'within');
    }
    expect([...seen].sort()).toEqual(['past', 'within']);
  });
});
