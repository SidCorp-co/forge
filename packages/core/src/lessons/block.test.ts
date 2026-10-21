import { describe, expect, it } from 'vitest';
import type { LessonEntry } from '../knowledge/index.js';
import { lessonsBlockText, lessonsFor } from './block.js';

const entry = (number: number, scope: LessonEntry['meta']['scope']): LessonEntry => ({
  slug: `lesson-${number}`,
  sentence: `sentence ${number}`,
  meta: { lessonId: `id-${number}`, number, scope },
});
const project = entry(1, { kind: 'project', areaId: null, areaName: null, itemKind: null });
const billing = entry(2, { kind: 'area', areaId: 'a-1', areaName: 'Billing', itemKind: null });
const reqs = entry(3, { kind: 'item_kind', areaId: null, areaName: null, itemKind: 'requirement' });
const all = [project, billing, reqs];
const numbers = (e: LessonEntry[]) => e.map((x) => x.meta.number);

describe('which lessons reach an agent (REQ-50 BC-3)', () => {
  it('a project lesson reaches everyone; a kind lesson only an agent producing that kind', () => {
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: null, raise: '' }))).toEqual([1]);
    expect(numbers(lessonsFor(all, { produces: ['requirement'], area: null, raise: '' }))).toEqual([
      1, 3,
    ]);
  });

  it("an area lesson reaches only its area's work, or every agent with no one subject", () => {
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'a-1', raise: '' }))).toEqual([
      1, 2,
    ]);
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'a-2', raise: '' }))).toEqual([1]);
    expect(numbers(lessonsFor(all, { produces: ['issue'], area: 'any', raise: '' }))).toEqual([
      1, 2,
    ]);
  });

  it('renders nothing where no lesson reaches, and says how to list and how to raise where one does', () => {
    expect(lessonsBlockText([reqs], { produces: ['issue'], area: null, raise: 'x' }, 2)).toBeNull();
    const text =
      lessonsBlockText(all, { produces: ['issue'], area: 'any', raise: 'the door' }, 3) ?? '';
    expect(text).toContain('### Lessons');
    expect(text).toContain('- L-2 [only work in the area Billing]: sentence 2');
    expect(text).toContain('Lessons applied: L-3, L-7');
    expect(text).toContain('stop guessing');
    expect(text).toContain('(the door)');
  });
});
