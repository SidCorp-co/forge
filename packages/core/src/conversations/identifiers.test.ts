import { describe, expect, it } from 'vitest';
import { identifiersIn, introducesSomethingNew } from './identifiers.js';

const ids = (t: string) => [...identifiersIn(t)].sort();

describe('what a message names', () => {
  it('finds an issue key, a path, a URL, a revision and a code span', () => {
    expect(ids('see ISS-1004 in packages/core/src/a.ts at 9e4d1a3b — `runWindow`')).toEqual(
      expect.arrayContaining([
        'iss-1004',
        'packages/core/src/a.ts',
        '9e4d1a3b',
        'runwindow',
        'a.ts',
      ]),
    );
    expect(ids('https://forge.example.co/issues/7')).toContain('https://forge.example.co/issues/7');
  });

  it('folds case, so the same name said twice is one identifier', () => {
    expect(identifiersIn('turnRunner').has('turnrunner')).toBe(true);
    expect(identifiersIn('TurnRunner').has('turnrunner')).toBe(true);
  });

  // cm:guard the failure this is planted to catch: with a bare-number pattern, "retry 1" and "retry 2" each name something new and the loop breaker never fires, which is the cost bound that replaced the mention gate failing open (ISS-1004 review F4).
  it('names nothing for a bare counter', () => {
    expect(ids('retry 1')).toEqual([]);
    expect(ids('retry 2')).toEqual([]);
    expect(introducesSomethingNew('retry 3', identifiersIn('retry 1 retry 2'))).toBe(false);
  });

  it('names nothing for ordinary agreement', () => {
    expect(ids('yes, agreed')).toEqual([]);
    expect(ids('ok will do')).toEqual([]);
  });

  it('still names a number that is attached to something', () => {
    expect(identifiersIn('v1.2.3').has('v1.2.3')).toBe(true);
    expect(identifiersIn('ISS-42').has('iss-42')).toBe(true);
  });
});

describe('introducesSomethingNew', () => {
  it('is false when every name is already in the room', () => {
    const seen = identifiersIn('ISS-1004 touches packages/core/src/a.ts');
    expect(introducesSomethingNew('I agree about ISS-1004 and a.ts', seen)).toBe(false);
  });

  it('is true on the first mention of a new one', () => {
    const seen = identifiersIn('ISS-1004');
    expect(introducesSomethingNew('and also ISS-1005', seen)).toBe(true);
  });
});
