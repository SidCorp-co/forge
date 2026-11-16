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

/**
 * Every lesson a map accounts for: named by slug, with its gist or among its situation's slugs, or
 * counted under its situation, or folded into the closing count. A map merges, so this is all of them.
 */
function accounted(text: string): { named: number; counted: number } {
  const named = new Set([...text.matchAll(/\blesson-\d+\b/g)].map((m) => m[0])).size;
  const sum = (re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
  const counted =
    sum(/^When [^\n]*: (\d+) lessons?$/gm) +
    sum(/^- and (\d+) more$/gm) +
    sum(/^(\d+) more lessons?, nearer other work: /gm);
  return { named, counted };
}

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

  it('holds its budget with five hundred lessons, the nearest first, merging the rest into counts and naming the list door', () => {
    // ten to an area, its name too long for a label: past the budget the nearest are named, the next
    // situations counted, and the rest folded into one count with the list door
    const many = Array.from({ length: 500 }, (_, i) =>
      entry(i + 1, {
        kind: 'area',
        areaId: `a-${Math.floor(i / 10)}`,
        areaName: `${Math.floor(i / 10)} is an area whose name runs well past any label it could fit`,
        itemKind: null,
      }),
    );
    for (const doorsOf of [doors, restLessonDoors('0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11')]) {
      const text = lessonsMapText(many, { produces: ['issue'], area: 'any', ...doorsOf }, 2) ?? '';
      expect(text.length).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
      const { named, counted } = accounted(text);
      expect(named).toBeGreaterThan(0);
      expect(named + counted).toBe(500);
      expect(text).toMatch(
        /^When working in 49 is an area[^\n]*…:\n- also lesson-500, lesson-499, /m,
      ); // the newest first, its long name cut
      expect(text).toMatch(
        new RegExp(
          `\\d+ more lessons, nearer other work: ${doorsOf.list.replace(/[?.*]/g, '\\$&')}`,
        ),
      );
      expect(lessonsMapOverflow(many, { produces: ['issue'], area: 'any', ...doorsOf })).toEqual({
        reach: 500,
        named,
        size: text.length,
        cap: LESSONS_MAP_MAX_CHARS,
      });
    }
  });

  it("names many lessons of a real project's size, its frame taking little of the budget (ISS-1251)", () => {
    // forge-dev 2026-11-16: forge's run map named 1 of 82 lessons, its frame taking most of the 1200;
    // at dev.701 it named 8 of 69 and dropped 61 behind a count line
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
    const map = lessonsMapOverflow(real, { produces: ['issue'], area: 'any', ...doorsOf });
    expect(map.size).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
    expect(map.named).toBeGreaterThanOrEqual(60);
    // the project's path is spelled once, never once per door
    const text = lessonsMapText(real, { produces: ['issue'], area: 'any', ...doorsOf }, 2) ?? '';
    expect(text.split('d1bb4907-74d9-4228-85ff-76121523af7d').length - 1).toBe(1);
    // none dropped: each is named, or counted under its situation beside the door that lists them
    const { named, counted } = accounted(text);
    expect(named + counted).toBe(82);
    expect(text).toContain(`Every lesson: ${doorsOf.list}`);
  });

  it('names a lesson by slug where its gist does not fit, and refuses the door by name where not even that fits', () => {
    const frame = lessonsMapText([project], aud({ produces: [], area: null }), 2) ?? '';
    expect(frame).toContain('When any work:\n- lesson-1: ');
    expect(frame).not.toContain('more lesson');
    // a read door that leaves room for less than one lesson's line, padded down to no room at all
    const free = LESSONS_MAP_MAX_CHARS - frame.length + doors.fetch.length;
    const seen = new Set<string>();
    for (let pad = free - 30; pad <= free + 30; pad += 1) {
      const tight = { produces: [], area: null, ...doors, fetch: 'f'.repeat(pad), list: 'L' };
      let text = '';
      try {
        text = lessonsMapText([project], tight, 2) ?? '';
      } catch (err) {
        // a lesson's slug is shorter than any count of it, so where no slug fits nothing does
        expect(String(err)).toMatch(
          /over its budget of 1200: its fetch, list or raise door is too long/,
        );
        seen.add('refused');
        continue;
      }
      expect(text.length, `fetch door padded to ${pad}`).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
      expect(accounted(text), `fetch door padded to ${pad}`).toEqual({ named: 1, counted: 0 });
      seen.add(text.includes('- lesson-1: ') ? 'gist' : 'slug');
    }
    expect([...seen]).toEqual(['gist', 'slug', 'refused']);
  });

  it('counts the line break before the count line, so a map that fills its budget exactly is never one over', () => {
    // forge-dev 2026-11-16: one project's map came to 1201 and the throw took down GET /devices/me/runners
    // sixty lessons in three situations: as the read door grows, the farthest situation is named,
    // then counted, then folded, and every lesson is accounted for at every length
    const many = Array.from({ length: 60 }, (_, i) =>
      entry(i + 1, {
        kind: 'area',
        areaId: `a-${i % 3}`,
        areaName: `Area ${i % 3}`,
        itemKind: null,
      }),
    );
    const seen = new Set<string>();
    for (let pad = 0; pad <= 900; pad += 1) {
      const at = {
        produces: [],
        area: 'any' as const,
        ...doors,
        fetch: `the read door${'f'.repeat(pad)}`,
      };
      const text = lessonsMapText(many, at, 2) ?? '';
      expect(text.length, `fetch door padded by ${pad}`).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
      const { named, counted } = accounted(text);
      expect(named + counted, `fetch door padded by ${pad}`).toBe(60);
      if (counted > 0) expect(text).toContain('the list door');
      if (/^When working in Area 0: 20 lessons$/m.test(text)) seen.add('counted');
      if (/^\d+ more lessons, nearer other work: the list door$/m.test(text)) seen.add('folded');
    }
    expect([...seen].sort()).toEqual(['counted', 'folded']);
  });

  it('refuses by name a door too long for the budget, never a longer map', () => {
    const wide = { produces: [], area: null, ...doors, raise: 'r'.repeat(LESSONS_MAP_MAX_CHARS) };
    expect(() => lessonsMapText([project], wide, 2)).toThrow(/over its budget/);
  });
});
