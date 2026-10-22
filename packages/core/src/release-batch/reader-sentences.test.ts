/**
 * Shape & release showed a person the caller's instruction for a check that could not run: "act on
 * the ones carrying `evaluated: true`, and retry EVERY entry shaped like this one" (ISS-1229 r8,
 * judge-20). A person reads what to do in words; the caller keeps its own sentence.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseBlockerCode } from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { releaseBlockerSentence } from './blocker-sentences.js';
import {
  RELEASE_CHECK_WORDS,
  releaseBlockerReaderSentence,
  warningWithReader,
  withReader,
} from './reader-sentences.js';

/** What only an API caller acts on: a response flag, a stored field, a decision value, a route. */
const CALLER_WORDING =
  /`(?:evaluated|releaseNotes|releaseRunnerLabel|ship-unverified|revert|cut-below|landing|verify\.probes)`|evaluated: true|\bEVERY\b|\{\s*"?\w+"?\s*:|\b(?:GET|POST) \/api|\([A-Z][A-Z_]{4,}\)/;

describe('a check that could not be run, as a person reads it', () => {
  it('says what to do in words, not the flag a caller reads', () => {
    const reader = releaseBlockerReaderSentence('RELEASE_CHECK_UNEVALUATED');
    expect(reader).not.toMatch(CALLER_WORDING);
    expect(reader).toContain('Load this page again to retry it.');
  });

  it('names the work that failed in words, with the reason it gave', () => {
    const reader = releaseBlockerReaderSentence('RELEASE_CHECK_UNEVALUATED', {
      check: 'criteria',
      detail: 'the probe timed out.',
    });
    expect(reader).toMatch(
      /^Weighing each issue's acceptance criteria failed \(the probe timed out\), so this answer cannot say whether a release would start/,
    );
    expect(reader).not.toContain('`criteria`');
  });

  it('leaves the caller its own instruction', () => {
    expect(releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED')).toContain(
      'act on the ones carrying `evaluated: true`',
    );
  });

  it('has words for every check a release reason can stand in for', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const named = new Set<string>();
    for (const file of readdirSync(here).filter(
      (f) => f.endsWith('.ts') && !f.includes('.test.'),
    )) {
      const text = readFileSync(join(here, file), 'utf8');
      for (const m of text.matchAll(/(?:evaluate|attempt|guarded)\(\s*'([a-z-]+)'/g))
        named.add(m[1] as string);
      for (const m of text.matchAll(/check: '([a-z-]+)'/g)) named.add(m[1] as string);
    }
    expect(named.size).toBeGreaterThan(10);
    expect([...named].filter((c) => !Object.hasOwn(RELEASE_CHECK_WORDS, c))).toEqual([]);
  });
});

/** Each reason Shape & release can list, with details as its check writes them. */
const ON_THE_SCREEN: Array<[ReleaseBlockerCode, Record<string, unknown> | undefined]> = [
  ['RELEASE_CHECK_UNEVALUATED', { check: 'carried', detail: 'the repository could not be read' }],
  ['RELEASE_CHECK_UNEVALUATED', undefined],
  [
    'RELEASE_CARRIES_UNDECIDED',
    {
      start: 'main',
      cut: 'a'.repeat(40),
      live: 'production',
      carried: [{ displayId: 'ISS-9', status: 'developed' }],
    },
  ],
  ['RELEASE_RECORD_MISSING', { issueIds: ['u-1'], displayIds: ['ISS-1'] }],
  [
    'RELEASE_WORK_UNMERGED',
    { issueIds: ['u-1', 'u-2'], displayIds: ['ISS-1', 'ISS-2'], shape: 'outside_git' },
  ],
  ['RELEASE_WORK_UNMERGED', { issueIds: ['u-1'], displayIds: ['ISS-1'], shape: 'git' }],
  [
    'RELEASE_ISSUES_UNCLOSABLE',
    {
      issueIds: ['u-1'],
      refused: [
        {
          issueId: 'u-1',
          displayId: 'ISS-1',
          shortfalls: [
            { code: 'OPEN_QUESTIONS', reason: 'holds 1 open question', clears: 'Answer it.' },
          ],
        },
      ],
    },
  ],
  ['RELEASE_PROBES_UNREADABLE', { urls: [], bindings: ['coolify-live'] }],
  ['RELEASE_ROSTER_EMPTY', { nearGate: 2 }],
  ['RELEASE_ROSTER_OVERSIZE', { waiting: 60, limit: 50 }],
  ['RELEASE_POOL_EMPTY', undefined],
  ['NO_RUNNER_ONLINE', undefined],
  ['BATCH_IN_FLIGHT', undefined],
  ['RELEASE_CRITERIA_UNEARNED', { held: [{ issueId: 'u', displayId: 'ISS-7', criteria: [1, 2] }] }],
  ['NO_RELEASE_GATE', undefined],
];

describe('every reason Shape & release lists, as a person reads it', () => {
  it.each(ON_THE_SCREEN)('%s names no act only an API caller takes', (code, details) => {
    expect(releaseBlockerReaderSentence(code, details)).not.toMatch(CALLER_WORDING);
  });

  it('tells a person how to decide a carried issue, in the dialog that decides it', () => {
    const [, details] = ON_THE_SCREEN[2] as [ReleaseBlockerCode, Record<string, unknown>];
    expect(releaseBlockerReaderSentence('RELEASE_CARRIES_UNDECIDED', details)).toContain(
      'It does not ship until a person decides it: when you release, choose Ship unverified, Reverted or Cut below for it in the Batch release dialog',
    );
  });

  it('keeps the caller sentence where a person reads the same act', () => {
    expect(releaseBlockerReaderSentence('RELEASE_ROSTER_EMPTY', { nearGate: 2 })).toBe(
      releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 2 }),
    );
  });

  it('rides on each blocker beside the caller sentence, which it leaves alone', () => {
    const b = blocker('RELEASE_CHECK_UNEVALUATED', { check: 'roster', detail: 'timeout' });
    const read = withReader(b);
    expect(read.message).toBe(b.message);
    expect(read.reader).toMatch(
      /^Reading which issues wait at the release gate failed \(timeout\)/,
    );
  });
});

// Judge-22 at 2734783: "each declare a verify step… Give its probe…" at two bindings.
describe('a verify step Forge cannot read, as a person reads it at one and at two', () => {
  const read = (bindings: string[]) =>
    releaseBlockerReaderSentence('RELEASE_PROBES_UNREADABLE', { urls: [], bindings });

  it('speaks of the one binding in the singular', () => {
    const one = read(['coolify-a']);
    expect(one).toContain('The live deploy binding `coolify-a` declares a verify step');
    expect(one).toContain('it names no probe with a url');
    expect(one).toContain('proved there and none closes past it. Give its probe a full url');
    expect(one).toContain('or remove the verify step, and a release with no probe');
  });

  it('speaks of two bindings in the plural throughout', () => {
    const two = read(['coolify-a', 'coolify-b']);
    expect(two).toContain(
      'The live deploy bindings `coolify-a`, `coolify-b` each declare a verify step',
    );
    expect(two).toContain('none of them names a probe with a url');
    expect(two).toContain(
      'proved at any of them and none closes past them. Give each probe a full url',
    );
    expect(two).toContain('or remove those verify steps, and a release with no probe');
    expect(two).not.toMatch(/\b(?:it|its)\b/);
  });
});

describe('the runner label warning, as a person reads it', () => {
  const warning = {
    code: 'RELEASE_RUNNER_PREFERENCE_UNMET' as const,
    message: 'caller sentence',
    details: { label: 'release-box', eligible: 1 },
  };

  it('names the field by the heading the screen shows, not the stored key', () => {
    const { reader, message } = warningWithReader(warning);
    expect(message).toBe('caller sentence');
    expect(reader).toContain('clear the Release runner label from the live deploy binding');
    expect(reader).not.toMatch(CALLER_WORDING);
  });
});

// ISS-1229 r11, judge-25: the screen said labels disagree without saying which.
describe('live bindings naming different release runners, as a person reads it', () => {
  it('names each label and counts them', () => {
    const read = releaseBlockerReaderSentence('RELEASE_RUNNER_AMBIGUOUS', {
      labels: ['box-a', 'box-b', 'box-c'],
    });
    expect(read).toBe(
      'Live bindings name 3 different release runners (box-a, box-b, box-c) — a release is refused rather than sent to whichever was created first. Give them the same label, or retire all but one.',
    );
  });

  it('keeps the general sentence where no label was read', () => {
    expect(releaseBlockerReaderSentence('RELEASE_RUNNER_AMBIGUOUS', { labels: [] })).not.toMatch(
      /\(\)/,
    );
  });
});
