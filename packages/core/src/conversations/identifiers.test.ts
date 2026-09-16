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

  it('names nothing for a bare counter', () => {
    expect(ids('retry 1')).toEqual([]);
    expect(ids('retry 2')).toEqual([]);
    expect(introducesSomethingNew('retry 3', identifiersIn('retry 1 retry 2'))).toBe(false);
  });

  it('names nothing for ordinary agreement', () => {
    expect(ids('yes, agreed')).toEqual([]);
    expect(ids('ok will do')).toEqual([]);
  });

  it('names a token whose underscores repeat, and one that ends on an underscore', () => {
    expect(identifiersIn('foo__bar').has('foo__bar')).toBe(true);
    expect(identifiersIn('foo_.bar').has('foo_.bar')).toBe(true);
    expect(identifiersIn('foo._bar').has('foo._bar')).toBe(true);
    expect(identifiersIn('foo_bar_').has('foo_bar_')).toBe(true);
    expect(identifiersIn('a__b__c').has('a__b__c')).toBe(true);
  });

  it('still names nothing for words an ellipsis joins', () => {
    expect(ids('wait...maybe')).toEqual([]);
    expect(ids('foo..bar')).toEqual([]);
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

describe('a hostile string', () => {
  const BUDGET_MS = 200;

  function millis(text: string): number {
    const started = performance.now();
    identifiersIn(text);
    return performance.now() - started;
  }

  it('stays inside its budget on a long run of separated digits', () => {
    expect(millis(`a${'0_'.repeat(40)}!`)).toBeLessThan(BUDGET_MS);
  });

  it('stays inside its budget on a long run of separator characters', () => {
    expect(millis(`a${'_'.repeat(400)}!`)).toBeLessThan(BUDGET_MS);
    expect(millis(`${'a_.'.repeat(200)}!`)).toBeLessThan(BUDGET_MS);
  });

  it('stays inside its budget on a long run of mixed case', () => {
    expect(millis(`${'aA'.repeat(60)}!`)).toBeLessThan(BUDGET_MS);
  });

  it('reads a dotted and a camel name out of the same sentence, whatever their case', () => {
    const found = identifiersIn('TurnRunner reads windows.ts and turnRunner does too');
    expect([...found]).toEqual(expect.arrayContaining(['turnrunner', 'windows.ts']));
    expect(found.has('turnrunner')).toBe(true);
  });

  it('still reads the identifiers out of an ordinary sentence', () => {
    expect([
      ...identifiersIn('ISS-1004 touches packages/core/src/conversations/windows.ts'),
    ]).toEqual(expect.arrayContaining(['iss-1004', 'packages/core/src/conversations/windows.ts']));
  });
});
