// A file the launch-check walk guards reads data by a key known only at run time through entryOf: the
// walk refuses a bracketed read by a key it cannot resolve, which can be `constructor` (ISS-1236 r10).
import { describe, expect, it } from 'vitest';
import { entryOf } from './entry-of.mjs';

describe('entryOf', () => {
  it('reads an own entry by a key known at run time', () => {
    const files = JSON.parse('{"a.ts": {"fileLines": 3}}');
    expect(entryOf(files, 'a.ts')).toEqual({ fileLines: 3 });
    expect(entryOf(files, 'b.ts')).toBeUndefined();
  });

  it('never hands back what a prototype holds, constructor among it', () => {
    const key = ['constr', 'uctor'].join('');
    expect(entryOf({}, key)).toBeUndefined();
    expect(entryOf(() => {}, key)).toBeUndefined();
    expect(
      entryOf(
        Object.getPrototypeOf(() => {}),
        key,
      ),
    ).toBeUndefined();
    expect(entryOf({ a: 1 }, 'toString')).toBeUndefined();
  });

  it('reads nothing off a missing object', () => {
    expect(entryOf(undefined, 'a')).toBeUndefined();
    expect(entryOf(null, 'a')).toBeUndefined();
  });
});
