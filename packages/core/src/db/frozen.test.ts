import { describe, expect, it } from 'vitest';
import { frozen } from './frozen.js';

describe('frozen', () => {
  it('refuses a write to the answer, its container and each row, of objects, arrays, maps and sets', () => {
    const rows = frozen([
      { id: 'b', tags: ['x'] },
      { id: 'a', tags: [] },
    ]);
    expect(() => rows.push({ id: 'c', tags: [] })).toThrow(TypeError);
    expect(() => rows.sort((x, y) => x.id.localeCompare(y.id))).toThrow(TypeError);
    expect(() => {
      (rows[0] as { id: string }).id = 'z';
    }).toThrow(TypeError);
    expect(() => (rows[0]?.tags as string[]).push('y')).toThrow(TypeError);

    const v = frozen({ m: new Map([['k', { d: 1 }]]), s: new Set([{ e: 1 }]) });
    expect(() => v.m.set('x', { d: 2 })).toThrow(/read answer shared across a request/);
    expect(() => {
      (v.m.get('k') as { d: number }).d = 2;
    }).toThrow(TypeError);
    expect(() => v.s.add({ e: 2 })).toThrow(/read answer shared/);
    expect(() => v.m.clear()).toThrow(/Map.clear/);
    // reads are untouched
    expect(v.m.get('k')).toEqual({ d: 1 });
    expect([...v.s]).toEqual([{ e: 1 }]);
  });

  it('leaves what a row holds below it writable: the gap it prices', () => {
    // answer → container → row → the row's jsonb: the evidence a verdict carries
    const v = frozen(new Map([['issue', [{ verdict: 'pass', evidence: { files: ['a'] } }]]]));
    const row = v.get('issue')?.[0] as { evidence: { files: string[] } };
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.evidence)).toBe(false);
  });

  it('answers the value it was handed, a cycle included', () => {
    const o: { self?: unknown; n: number } = { n: 1 };
    o.self = o;
    expect(frozen(o)).toBe(o);
    expect(Object.isFrozen(o)).toBe(true);
    expect(frozen(null)).toBe(null);
    expect(frozen(3)).toBe(3);
  });
});
