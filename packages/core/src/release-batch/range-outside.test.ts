// ISS-962: which gate issues outside a release's roster the head its run reports carries, read by the
// project's ancestry before the tag is owed; agenfold's 0.123.0 was tagged at ISS-144's landing.
// @direct-test-of packages/core/src/release-batch/range-outside.ts

import { describe, expect, it } from 'vitest';
import { type OutsideIssue, outsideSentence, placeOutside, uncheckedOf } from './range-outside.js';

const BASE = 'b'.repeat(40);
const HEAD = 'a939c3f'.padEnd(40, '0');
const IN = '1'.repeat(40);
const OLD = '2'.repeat(40);
const SIDE = '3'.repeat(40);

/** What each release commit holds: the head holds IN and OLD, the base holds OLD alone. */
const HOLDS: Record<string, readonly string[]> = { [HEAD]: [IN, OLD, BASE], [BASE]: [OLD] };

type Answer = boolean | { unread: string };
const asked: Array<{ commit: string; release: string }[]> = [];
const ask =
  (answer: (commit: string, release: string) => Answer = (c, r) => !!HOLDS[r]?.includes(c)) =>
  async (pairs: readonly { commit: string; release: string }[]) => {
    asked.push([...pairs]);
    return new Map(pairs.map((p) => [`${p.commit}@${p.release}`, answer(p.commit, p.release)]));
  };

const issue = (key: string, commit: string | null): OutsideIssue => ({ id: key, key, commit });

describe('the gate issues outside the roster a reported head carries (ISS-962)', () => {
  it('names a landing the head holds and the base does not, and no other', async () => {
    const read = await placeOutside(
      [issue('ISS-144', IN), issue('ISS-90', OLD), issue('ISS-77', SIDE)],
      BASE,
      HEAD,
      ask(),
    );
    expect(read.carried.map((i) => i.key)).toEqual(['ISS-144']);
    expect(read.unchecked).toEqual([]);
  });

  it('carries a landing that is the head itself and passes one that is the base, asking nothing', async () => {
    asked.length = 0;
    const read = await placeOutside(
      [issue('ISS-144', HEAD.toUpperCase()), issue('ISS-90', BASE)],
      BASE,
      HEAD,
      { why: 'no reader' },
    );
    expect(read.carried).toEqual([{ id: 'ISS-144', key: 'ISS-144', commit: HEAD }]);
    expect(read.unchecked).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('with no release before, counts every landing the head holds', async () => {
    const read = await placeOutside(
      [issue('ISS-90', OLD), issue('ISS-77', SIDE)],
      null,
      HEAD,
      ask(),
    );
    expect(read.carried.map((i) => i.key)).toEqual(['ISS-90']);
  });

  it('keeps as unchecked, with why, what no reader placed, never guessing either way', async () => {
    const none = await placeOutside([issue('ISS-1', IN), issue('ISS-2', null)], BASE, HEAD, {
      why: 'the source host binding cannot serve',
    });
    expect(none).toEqual({
      carried: [],
      unchecked: [
        { issueKey: 'ISS-2', commit: null, why: 'its merge names no commit' },
        { issueKey: 'ISS-1', commit: IN, why: 'the source host binding cannot serve' },
      ],
    });
    const silent = await placeOutside([issue('ISS-1', IN)], BASE, HEAD, async () => ({
      silent: 'no box answered',
    }));
    expect(silent.unchecked).toEqual([
      { issueKey: 'ISS-1', commit: IN, why: 'nobody read its ancestry: no box answered' },
    ]);
  });

  it('settles a pair half read where the read half decides, and keeps the rest unchecked', async () => {
    const unread = { unread: 'git could not find it' };
    const read = await placeOutside(
      [issue('NOT-IN-HEAD', SIDE), issue('IN-BASE', OLD), issue('UNSURE', IN)],
      BASE,
      HEAD,
      ask((c, r) => {
        if (c === SIDE) return r === HEAD ? false : unread;
        if (c === OLD) return r === BASE ? true : unread;
        return r === HEAD ? true : unread;
      }),
    );
    expect(read.carried).toEqual([]);
    expect(read.unchecked).toEqual([
      {
        issueKey: 'UNSURE',
        commit: IN,
        why: 'whether a939c3f carries it could not be read: git could not find it',
      },
    ]);
  });

  it('words the refusal with each issue, its landing and what the run does instead', () => {
    const words = outsideSentence(HEAD, '0.123.0', [issue('ISS-144', HEAD)]);
    expect(words).toContain(
      'a939c3f carries the landing of 1 issue waiting at the release gate outside this release',
    );
    expect(words).toContain('ISS-144 (landed at a939c3f)');
    expect(words).toContain('v0.123.0 would ship it with no record');
    expect(words).toContain('do not deploy');
    expect(outsideSentence(HEAD, null, [issue('A', IN), issue('B', OLD)])).toContain(
      '2 issues waiting',
    );
  });

  it('reads a kept list back, and a reading kept before the check as not checked', () => {
    expect(uncheckedOf(undefined)).toBeNull();
    expect(uncheckedOf([{ issueKey: 'ISS-1', commit: null, why: 'w' }])).toEqual([
      { issueKey: 'ISS-1', commit: null, why: 'w' },
    ]);
    // an entry that is not one makes the list untrustworthy whole, never a shorter list
    expect(uncheckedOf([{ issueKey: 'ISS-1', commit: null, why: 'w' }, { bad: 1 }])).toBeNull();
  });
});
