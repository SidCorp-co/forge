import { describe, expect, it } from 'vitest';
import type { LessonEntry } from '../knowledge/index.js';
import {
  LESSONS_MAP_MAX_CHARS,
  type LessonAudience,
  lessonsFor,
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

  it('names each slug with its scope and how to read, apply and raise, and no sentence', () => {
    const text = lessonsMapText(all, aud({ produces: ['requirement'], area: 'any' }), 3) ?? '';
    expect(text).toContain('### Lessons');
    expect(text).toContain('lesson-2 [area Billing], lesson-3 [requirements], lesson-1 [all work]');
    expect(text).not.toContain('Said once as rule');
    expect(text).toContain('the read door');
    expect(text).toContain('Lessons applied: L-3, L-7');
    expect(text).toContain('(the raise door)');
    expect(text).not.toContain('the list door');
  });

  it('holds its budget with five hundred lessons, counting the rest and naming the list door', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      entry(i + 1, {
        kind: 'area',
        areaId: `a-${i}`,
        areaName: `An area whose name runs well past any label it could fit ${i}`,
        itemKind: null,
      }),
    );
    for (const doorsOf of [doors, restLessonDoors('0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11')]) {
      const text = lessonsMapText(many, { produces: ['issue'], area: 'any', ...doorsOf }, 2) ?? '';
      expect(text.length).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
      const named = text.match(/lesson-\d+ \[/g)?.length ?? 0;
      expect(named).toBeGreaterThan(0);
      expect(text).toContain(`, and ${500 - named} more: ${doorsOf.list}`);
      expect(text).toContain('lesson-500 ['); // the newest first
      expect(text).toContain('…]'); // a long area name is cut
    }
  });

  it('says only the count and the list door where not one slug fits beside the frame', () => {
    const frame = lessonsMapText([project], aud({ produces: [], area: null }), 2) ?? '';
    expect(frame).toContain('lesson-1 [all work]');
    expect(frame).not.toContain('more:');
    // a read door that leaves room for the count line and not for one slug
    const pad = 'f'.repeat(LESSONS_MAP_MAX_CHARS - frame.length + doors.fetch.length + 3);
    const tight = { produces: [], area: null, ...doors, fetch: pad, list: 'L' };
    const text = lessonsMapText([project], tight, 2) ?? '';
    expect(text.length).toBeLessThanOrEqual(LESSONS_MAP_MAX_CHARS);
    expect(text).not.toContain('lesson-1 [');
    expect(text).toContain('1 lessons: L');
  });

  it('refuses by name a door too long for the budget, never a longer map', () => {
    const wide = { produces: [], area: null, ...doors, raise: 'r'.repeat(LESSONS_MAP_MAX_CHARS) };
    expect(() => lessonsMapText([project], wide, 2)).toThrow(/over its budget/);
  });
});
