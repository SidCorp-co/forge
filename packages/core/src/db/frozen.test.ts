import { describe, expect, it } from 'vitest';
import { frozen } from './frozen.js';

describe('frozen', () => {
  it('refuses a write at any depth of objects, arrays, maps and sets', () => {
    const v = frozen({
      a: { b: [1, { c: 2 }] },
      m: new Map([['k', { d: 1 }]]),
      s: new Set([{ e: 1 }]),
    });
    expect(() => {
      (v.a.b[1] as { c: number }).c = 3;
    }).toThrow(TypeError);
    expect(() => (v.a.b as unknown[]).push(1)).toThrow(TypeError);
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

  it('answers the value it was handed, a cycle included', () => {
    const o: { self?: unknown; n: number } = { n: 1 };
    o.self = o;
    expect(frozen(o)).toBe(o);
    expect(Object.isFrozen(o)).toBe(true);
    expect(frozen(null)).toBe(null);
    expect(frozen(3)).toBe(3);
  });
});
