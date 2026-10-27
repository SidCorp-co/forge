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
import { readableThrough } from '../projects/repository-access.js';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';
import { blocker } from './blocker-kit.js';
import { releaseBlockerSentence } from './blocker-sentences.js';
import {
  RELEASE_CHECK_WORDS,
  recordMissingForRow,
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

  // ISS-1300 r3: loading the page again reads the same refusal, so neither door says to retry.
  // r4 (judge-121): the request it was read by stays in `details.detail`, out of the sentence.
  it('says the repository Forge cannot read, and what restores it, where the repository refused the read', () => {
    const details = {
      check: 'carried',
      detail:
        'o/r could not read the head of main: GET /repos/o/r/commits/main on o/r returned HTTP 404',
      repository: 'o/r',
      clears: readableThrough('binding', 'o/r'),
    };
    const cannot = `Forge cannot read o/r, and checks again ${readableThrough('binding', 'o/r')}.`;
    const reader = releaseBlockerReaderSentence('RELEASE_CHECK_UNEVALUATED', details);
    const caller = releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', details);

    expect(
      reader.startsWith(
        `Reading which landings this release would carry beyond its issues failed: ${cannot}`,
      ),
    ).toBe(true);
    expect(caller.startsWith(cannot)).toBe(true);
    for (const said of [reader, caller]) {
      expect(said).not.toMatch(/retry|Load this page again|GET \/repos|HTTP 404|tracker/i);
    }
  });

  // ISS-1300 r4 (judge-121): a repository read and lacking a branch says which, never to retry.
  it('says which branch a readable repository lacks, and what supplies it', () => {
    const details = {
      check: 'carried',
      detail: 'o/r has no branch production',
      repository: 'o/r',
      lacks: 'o/r has no branch production',
      clears:
        "once o/r has a branch production, or the project's release chain names only branches it has",
    };
    const reader = releaseBlockerReaderSentence('RELEASE_CHECK_UNEVALUATED', details);
    const caller = releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', details);

    expect(reader).toBe(
      "Reading which landings this release would carry beyond its issues failed: o/r has no branch production, so this answer cannot say whether a release would start: whatever that check would have found is missing from this list. It is read again once o/r has a branch production, or the project's release chain names only branches it has.",
    );
    for (const said of [reader, caller]) {
      expect(said).not.toMatch(/retry|Load this page again|Forge cannot read/i);
    }
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
      'It is not released until a person decides it: when you release, choose Release unverified, Reverted or Cut below for it in the Batch release dialog',
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
    expect(one).toContain('The live deploy target `coolify-a` declares a verify step');
    expect(one).toContain('it names no probe with a url');
    expect(one).toContain('proved there and none closes past it. Give its probe a full url');
    expect(one).toContain('or remove the verify step, and a release with no probe');
  });

  it('speaks of two bindings in the plural throughout', () => {
    const two = read(['coolify-a', 'coolify-b']);
    expect(two).toContain(
      'The live deploy targets `coolify-a`, `coolify-b` each declare a verify step',
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
    expect(reader).toContain('clear the Release runner label from the live deploy target');
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
      'Live deploy targets name 3 different release runners (box-a, box-b, box-c) — a release is refused rather than sent to whichever was created first. Give them the same label, or retire all but one.',
    );
  });

  it('keeps the general sentence where no label was read', () => {
    expect(releaseBlockerReaderSentence('RELEASE_RUNNER_AMBIGUOUS', { labels: [] })).not.toMatch(
      /\(\)/,
    );
  });
});

// Judge-155 at c0f8105 (criterion 367): the gate said "a second one would claim the same issues. Let
// it finish, or abort it" of a release carrying ISS-3 only, and no screen offers an abort.
describe('a release already running, as a person at the gate reads it', () => {
  const read = (details: Record<string, unknown>) =>
    releaseBlockerReaderSentence('BATCH_IN_FLIGHT', details);

  it('names what the running release carries and what the other waiting issues do', () => {
    const said = read({ runId: 'r1', carries: ['ISS-3'], rest: ['ISS-1', 'ISS-2'] });
    expect(said).toBe(
      'A release is already running for this project, carrying ISS-3. A project runs one release at a time, so ISS-1 and ISS-2 are on no release and wait until it finishes.',
    );
  });

  it('claims no overlap it did not read, and tells a person to abort nothing', () => {
    for (const details of [
      { runId: 'r1' },
      { runId: 'r1', carries: ['ISS-3'], rest: ['ISS-1'] },
      { runId: 'r1', carries: ['ISS-3'], decision: { displayId: 'ISS-3' } },
    ]) {
      const said = read(details);
      expect(said).not.toMatch(/same issues|abort/i);
      expect(said).not.toContain('`');
    }
  });

  it('says the waiting issue in the singular and every other issue where the gate lists none', () => {
    expect(read({ runId: 'r1', carries: ['ISS-3'], rest: ['ISS-1'] })).toContain(
      'so ISS-1 is on no release and waits until it finishes.',
    );
    expect(read({ runId: 'r1', carries: ['ISS-3', 'ISS-4', 'ISS-5'] })).toBe(
      'A release is already running for this project, carrying ISS-3, ISS-4 and ISS-5. A project runs one release at a time, so every other issue waits until it finishes.',
    );
  });

  it('says where the decision it waits on is answered', () => {
    expect(read({ runId: 'r1', carries: ['ISS-3'], decision: { displayId: 'ISS-64' } })).toContain(
      'It is waiting on a decision: its agent stopped on a question on ISS-64. Answer it in its Decision waiting card and that release goes on.',
    );
    expect(read({ runId: 'r1', decision: { displayId: null } })).toContain(
      "a question among this project's questions",
    );
  });

  it('leaves the caller its own sentence, which no longer claims the same issues', () => {
    const caller = releaseBlockerSentence('BATCH_IN_FLIGHT', { runId: 'r1', carries: ['ISS-3'] });
    expect(caller).toBe(
      'A release is already running for this project, and a project runs one release at a time. Let it finish, or abort it with what you found.',
    );
  });
});

// Judge-155: "`j155-scratch-box` has not finished provisioning its workspace (`queued`)" on the gate.
describe('a runner that cannot take a release, as a person at the gate reads it', () => {
  const runners = (over: Partial<RunnerHold>): RunnerHold[] => [
    {
      deviceName: 'j155-box',
      reason: 'provisioning',
      lastSeenSeconds: 13,
      reporting: true,
      ...over,
    },
  ];
  const STORED =
    /`|\b(?:queued|cloning|syncing_skills|writing_mcp|needs_manual_setup|draining|disabled)\b|\d{4}-\d\d-\d\dT/;

  it('names the box and says a provision in words', () => {
    const said = releaseBlockerReaderSentence('NO_RUNNER_ONLINE', {
      runners: runners({ detail: 'queued' }),
    });
    expect(said).toBe(
      'This project has 1 runner registered and it cannot take a release right now. The box j155-box has not finished setting up its workspace for this project: it is waiting its turn to start. Watch it under Settings → Runners; a setup that is stuck is run again from there. It is up and reporting, last seen less than a minute ago.',
    );
  });

  it.each<[RunnerHoldReason, string | undefined]>([
    ['device-disabled', undefined],
    ['retired', 'draining'],
    ['retired', 'disabled'],
    ['never-connected', undefined],
    ['disconnected', undefined],
    ['stale', undefined],
    ['auth', undefined],
    ['rate-limited', '2026-10-27T14:05:00.000Z'],
    ['quarantined', '2026-10-27T14:05:00.000Z'],
    ['provisioning', 'cloning'],
    ['provisioning', 'syncing_skills'],
    ['provisioning', 'writing_mcp'],
    ['provisioning', 'needs_manual_setup'],
    ['provision-stalled', 'cloning'],
    ['below-floor', '0.0.0-j155'],
  ])('%s (%s) carries no code mark, stored value or ISO stamp', (reason, detail) => {
    const said = releaseBlockerReaderSentence('NO_RUNNER_ONLINE', {
      runners: runners({ reason, ...(detail ? { detail } : {}), stalledSeconds: 7200 }),
    });
    expect(said).toContain('The box j155-box ');
    expect(said).not.toMatch(STORED);
  });

  // ISS-1421 r39, judge-160: a box whose heartbeats stopped was said to have "reported itself
  // offline"; Forge marks it offline, the box says nothing.
  it('says a box Forge marked offline stopped reporting, to a person and to a caller', () => {
    const details = { runners: runners({ reason: 'disconnected', lastSeenSeconds: 269, reporting: false }) };
    for (const said of [
      releaseBlockerReaderSentence('NO_RUNNER_ONLINE', details),
      releaseBlockerSentence('NO_RUNNER_ONLINE', details),
    ]) {
      expect(said).toContain('stopped reporting, and Forge marked it offline');
      expect(said).not.toContain('reported itself offline');
    }
  });

  it('says a rate limit ends at a moment in words', () => {
    const said = releaseBlockerReaderSentence('NO_RUNNER_ONLINE', {
      runners: runners({ reason: 'rate-limited', detail: '2026-10-27T14:05:00.000Z' }),
    });
    expect(said).toContain('is rate limited until 27 October 2026, 14:05 UTC.');
  });

  it('leaves the caller its own clause, the box and the state marked as values', () => {
    const caller = releaseBlockerSentence('NO_RUNNER_ONLINE', {
      runners: runners({ detail: 'queued' }),
    });
    expect(caller).toContain('`j155-box` has not finished provisioning its workspace (`queued`)');
  });
});

describe("a missing release note, as the gate's row and the issue's page say it", () => {
  it('says it is written under Release note on the issue page, asking nobody', () => {
    expect(recordMissingForRow(false)).toContain(
      "A member of the project writes one under Release note on the issue's page",
    );
    expect(recordMissingForRow(true)).toContain('writes one under Release note on this page');
    for (const said of [recordMissingForRow(false), recordMissingForRow(true)]) {
      expect(said).not.toMatch(/ask for it|The agent that lands/);
    }
  });

  it('says the same in the refusal a person meets on pressing Release now', () => {
    expect(
      releaseBlockerReaderSentence('RELEASE_RECORD_MISSING', {
        issueIds: ['u-2'],
        displayIds: ['ISS-2'],
      }),
    ).toContain("Write one first, under Release note on the issue's page");
  });

  // ISS-1421 r39, judge-160: at two or more the request read "Give each one first, under Release
  // note on each page", which a person read as giving the issue, and which named no page.
  const KEYS = ['ISS-1', 'ISS-2', 'ISS-3', 'ISS-4', 'ISS-5'];
  const missing = (n: number) =>
    releaseBlockerReaderSentence('RELEASE_RECORD_MISSING', {
      issueIds: KEYS.slice(0, n).map((_, i) => `u-${i}`),
      displayIds: KEYS.slice(0, n),
    });

  it.each([1, 2, 5])('names every issue and says its note is written on its own page, at %i', (n) => {
    const said = missing(n);
    for (const key of KEYS.slice(0, n)) expect(said).toContain(key);
    expect(said).toMatch(n === 1 ? /under Release note on the issue's page/ : /under Release note on each issue's own page/);
    expect(said).not.toMatch(/Give each one|each page|\bship/);
  });

  it('asks for one note per issue in the plural, and one note in the singular', () => {
    expect(missing(2)).toContain('have no release note, so a release would close them with nothing telling users what changed. Write a note for each of them first');
    expect(missing(1)).toContain('has no release note, so a release would close it with nothing telling users what changed. Write one first');
  });

  it("says on the gate's row what a release would do, not that it would claim a ship", () => {
    expect(recordMissingForRow(false)).toContain('so a release would close it with nothing telling users what changed');
  });
});

describe('an issue not marked merged, as a person reads it', () => {
  it('says it is not marked merged and names Mark merged, never that Forge watched no merge land', () => {
    const one = releaseBlockerReaderSentence('RELEASE_WORK_UNMERGED', { issueIds: ['u-1'], displayIds: ['ISS-1'], shape: 'git' });
    expect(one).toContain('is not marked merged');
    expect(one).toContain("Use Mark merged in the issue's properties first");
    const two = releaseBlockerReaderSentence('RELEASE_WORK_UNMERGED', { issueIds: ['u-1', 'u-2'], displayIds: ['ISS-1', 'ISS-2'], shape: 'git' });
    expect(two).toContain('are not marked merged');
    expect(two).toContain("Use Mark merged in each issue's properties first");
    for (const said of [one, two, releaseBlockerSentence('RELEASE_WORK_UNMERGED', { issueIds: ['u-1'], displayIds: ['ISS-1'], shape: 'git' })]) {
      expect(said).not.toMatch(/watched land|\bship/);
    }
  });
});
