import { describe, expect, it } from 'vitest';
import { classifyReplay, ownerOfPath } from './attribute.mjs';

const landed = [
  { issue: 'ISS-1', landing: 'a' },
  { issue: 'ISS-2', landing: 'b' },
  { issue: 'ISS-3', landing: 'c' },
];

describe('ownerOfPath', () => {
  it('names the last landing to change the path, whoever changed it first', () => {
    const r = ownerOfPath({ landed, changed: (l) => l === 'a' || l === 'b' });
    expect(r.owner).toBe('ISS-2');
    expect(r.says).toMatch(/ISS-1 changed it earlier and were green when admitted/);
  });

  it('names no owner where no member changed the path', () => {
    expect(ownerOfPath({ landed, changed: () => false })).toMatchObject({
      kind: 'unowned',
      owner: null,
    });
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
