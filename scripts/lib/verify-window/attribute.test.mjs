import { describe, expect, it } from 'vitest';
import { classifyReplay, ownerOfPath } from './attribute.mjs';

const landed = [
  { issue: 'ISS-1', landing: 'a' },
  { issue: 'ISS-2', landing: 'b' },
  { issue: 'ISS-3', landing: 'c' },
];

const files = {
  a: ['packages/core/src/x.ts'],
  b: ['packages/core/src/x.ts', 'packages/web-v2/src/x.ts'],
  c: ['docs/y.md'],
};
const filesOf = (landing) => files[landing];

describe('ownerOfPath', () => {
  it('names the last landing to change the path, whoever changed it first', () => {
    const r = ownerOfPath({ landed, path: 'packages/core/src/x.ts', filesOf });
    expect(r.owner).toBe('ISS-2');
    expect(r.says).toMatch(/ISS-1 changed it earlier and were green when admitted/);
  });

  it('reads a directory as every path under it', () => {
    expect(ownerOfPath({ landed, path: 'docs/', filesOf }).owner).toBe('ISS-3');
  });

  it('names no owner where no member changed the path', () => {
    expect(ownerOfPath({ landed, path: 'nowhere.ts', filesOf })).toMatchObject({
      kind: 'unowned',
      owner: null,
    });
  });

  it('names the longer paths a path relative to a package ends, and guesses no owner', () => {
    expect(ownerOfPath({ landed, path: 'src/x.ts', filesOf })).toEqual({
      kind: 'unresolved',
      owner: null,
      says: 'no landing changed `src/x.ts` as given, and it ends a path landings did change (ISS-1 changed packages/core/src/x.ts; ISS-2 changed packages/core/src/x.ts; ISS-2 changed packages/web-v2/src/x.ts): attribute again with the path from the repository root',
    });
  });

  it('takes the exact path over a longer one it ends', () => {
    const both = { a: ['x.ts', 'packages/core/x.ts'] };
    const r = ownerOfPath({ landed: [landed[0]], path: 'x.ts', filesOf: (l) => both[l] });
    expect(r).toMatchObject({ kind: 'member', owner: 'ISS-1' });
  });
});

describe('classifyReplay', () => {
  const pass = { failed: false };
  const fail = { failed: true };
  const ms = (...f) => f.map((failed, i) => ({ issue: `ISS-${i + 1}`, failed }));

  it('reads a failure on the base alone as pre-existing', () => {
    expect(classifyReplay({ base: fail, members: ms(true, true), window: fail }).kind).toBe(
      'pre-existing',
    );
  });

  it('names the one member it fails on alone', () => {
    expect(classifyReplay({ base: pass, members: ms(false, true), window: fail })).toMatchObject({
      kind: 'member',
      owner: 'ISS-2',
    });
  });

  it('reads a failure on no member alone and on the window as an interaction', () => {
    expect(classifyReplay({ base: pass, members: ms(false, false), window: fail }).kind).toBe(
      'interaction',
    );
  });

  it('names no owner where it fails on several members alone', () => {
    expect(classifyReplay({ base: pass, members: ms(true, true), window: fail })).toMatchObject({
      kind: 'undetermined',
      owner: null,
    });
  });

  it('names no owner where the replay did not reproduce it', () => {
    expect(classifyReplay({ base: pass, members: ms(false), window: pass }).says).toMatch(
      /did not fail on the replay/,
    );
  });
});

describe('classifyReplay with a member that could not be rebuilt', () => {
  it('names no owner and says which member and why', () => {
    const r = classifyReplay({
      base: { failed: false },
      members: [
        { issue: 'ISS-1', failed: false, unbuilt: 'conflicts on x' },
        { issue: 'ISS-2', failed: false },
      ],
      window: { failed: true },
    });
    expect(r).toMatchObject({ kind: 'undetermined', owner: null });
    expect(r.says).toBe(
      'ISS-1 could not be rebuilt alone (conflicts on x), so no replay of it ran and no owner is named',
    );
  });
});
