/**
 * Every word in a release sentence that agrees with a count follows it, not only the noun
 * (ISS-1229 r8, judge-20): with one roster issue the cut-below refusal read "roster issue ISS-1
 * above the cut, so the batch would name issues it does not ship. Take them off the roster".
 * Each sentence that counts is read here at one and at two.
 */

import { describe, expect, it } from 'vitest';
import type { RunnerHold } from '../runners/ineligible.js';
import {
  heldBackWarningSentence,
  releaseBlockerSentence,
  rosterInPartsWarningSentence,
  uncorroboratedWarningSentence,
} from './blocker-sentences.js';
import type { ServingReading } from './serving-reading.js';

const range = { start: 'main', cut: 'a'.repeat(40), live: 'production' };
const ids = (n: number) => ['ISS-1', 'ISS-2', 'ISS-3'].slice(0, n);
const held = (n: number) =>
  ids(n).map((displayId, i) => ({ issueId: `u-${i}`, displayId, criteria: [1] }));
const hold = (deviceName: string): RunnerHold => ({
  deviceName,
  reason: 'stale',
  lastSeenSeconds: 900,
  reporting: false,
});
const served: ServingReading = { kind: 'serving', served: [], unread: [], readAt: 'now' };

describe('a cut-below that leaves roster issues above it', () => {
  const sentence = (n: number) =>
    releaseBlockerSentence('RELEASE_CUT_DROPS_ROSTER', { ...range, displayIds: ids(n) });

  it('names one issue as it, at one', () => {
    expect(sentence(1)).toContain(
      'roster issue `ISS-1` above the cut, so the batch would name an issue it does not ship. Take it off the roster,',
    );
  });

  it('names them as them, at two', () => {
    expect(sentence(2)).toContain(
      'roster issues `ISS-1`, `ISS-2` above the cut, so the batch would name issues it does not ship. Take them off the roster,',
    );
  });
});

describe('a range carrying issues the batch does not name', () => {
  const sentence = (n: number) =>
    releaseBlockerSentence('RELEASE_CARRIES_UNDECIDED', {
      ...range,
      carried: ids(n).map((displayId) => ({ displayId, status: 'developed' })),
    });

  it('says it does not ship without a decision, at one', () => {
    expect(sentence(1)).toContain('It does not ship without a decision. Send one with the batch:');
    expect(sentence(1)).toContain('Or move it to the release gate and name it on the roster.');
    expect(sentence(1)).not.toMatch(/\b(them|None of)\b/);
  });

  it('says none of them ships without one, at two', () => {
    expect(sentence(2)).toContain(
      'None of them ships without a decision. Send one per issue with the batch:',
    );
    expect(sentence(2)).toContain('Or move each to the release gate and name it on the roster.');
  });
});

describe('the runners that cannot take a release', () => {
  it('says it cannot, at one', () => {
    expect(releaseBlockerSentence('NO_RUNNER_ONLINE', { runners: [hold('a')] })).toContain(
      'This project has 1 runner registered and it cannot take a release right now.',
    );
  });

  it('says not one of them can, at two', () => {
    expect(
      releaseBlockerSentence('NO_RUNNER_ONLINE', { runners: [hold('a'), hold('b')] }),
    ).toContain('This project has 2 runners registered and not one of them can take a release');
  });
});

describe('the issues one move short of the gate', () => {
  it('says it moves, at one', () => {
    expect(releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 1 })).toBe(
      'Nothing is ready to release: 1 issue is at Testing or Tested, and it moves to Awaiting release once it records where its change now runs.',
    );
  });

  it('says each moves, at two', () => {
    expect(releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 2 })).toContain(
      '2 issues are at Testing or Tested, and each moves to Awaiting release',
    );
  });
});

describe('the issues whose close this release would be refused', () => {
  const shortfall = { code: 'CLOSE_REQUIRES_SHIPPED', reason: 'no merge', clears: 'mark it' };
  const sentence = (n: number) =>
    releaseBlockerSentence('RELEASE_ISSUES_UNCLOSABLE', {
      issueIds: ids(n),
      refused: ids(n).map((displayId, i) => ({
        issueId: `u-${i}`,
        displayId,
        shortfalls: [shortfall],
      })),
    });

  it('leaves it off and clears that reason, at one', () => {
    expect(sentence(1)).toContain('Clear that reason, or leave it off this release.');
  });

  it('leaves each off and clears each reason, at two', () => {
    expect(sentence(2)).toContain('Clear each reason, or leave each such issue off this release.');
  });
});

describe('a probe whose url is not a url', () => {
  const sentence = (urls: string[]) =>
    releaseBlockerSentence('RELEASE_PROBES_UNREADABLE', { urls });

  it('speaks of the one probe, at one', () => {
    expect(sentence(['htp//a'])).toBe(
      '`htp//a` — A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.',
    );
  });

  it('counts the probes and speaks of them, at two', () => {
    const two = sentence(['htp//a', 'ftp:/b']);
    expect(two).toContain(
      '`htp//a`, `ftp:/b` — 2 declared verification probes hold urls that are not urls',
    );
    expect(two).toContain('could ever be made to them');
    expect(two).toContain('Correct each probe, including its scheme.');
  });
});

describe('a live deploy binding whose verify Forge cannot read', () => {
  const sentence = (bindings: string[]) =>
    releaseBlockerSentence('RELEASE_PROBES_UNREADABLE', { urls: [], bindings });

  it('says the binding declares it, at one', () => {
    expect(sentence(['coolify-a'])).toContain(
      'The live deploy target `coolify-a` declares a `verify` Forge cannot read',
    );
  });

  it('says the bindings each declare one, at two', () => {
    expect(sentence(['coolify-a', 'coolify-b'])).toContain(
      'The live deploy targets `coolify-a`, `coolify-b` each declare a `verify` Forge cannot read',
    );
  });

  // Judge-22 at 2734783: "each declare…" went on in the singular, "Correct it… remove it".
  it('says what it names and what to correct in the singular, at one', () => {
    const one = sentence(['coolify-a']);
    expect(one).toContain('— it names no probe with a url —');
    expect(one).toContain('proved there and none closes past it. Correct it to');
    expect(one).toContain(', or remove it, and a release with no probe');
  });

  it('says what they name and what to correct in the plural, at two', () => {
    const two = sentence(['coolify-a', 'coolify-b']);
    expect(two).toContain('— none of them names a probe with a url —');
    expect(two).toContain('proved at any of them and none closes past them. Correct each to');
    expect(two).toContain(', or remove them, and a release with no probe');
    expect(two).not.toMatch(/\bit\b/);
  });
});

describe('the warning about criteria earned at a runtime nothing could re-read', () => {
  it('says one issue carries, at one', () => {
    expect(uncorroboratedWarningSentence(held(1), 'the probe timed out.')).toMatch(
      /^1 issue carries a criterion/,
    );
  });

  it('says two issues carry, at two', () => {
    expect(uncorroboratedWarningSentence(held(2), 'the probe timed out.')).toMatch(
      /^2 issues carry a criterion/,
    );
  });
});

describe('the warning about issues the sweep holds back', () => {
  const undeclared: ServingReading = { kind: 'undeclared', missing: 'a probe', route: 'add one' };

  it('says it owes and stays, at one', () => {
    expect(heldBackWarningSentence(held(1), served)).toContain(
      'without 1 issue the sweep is holding back: it still owes a judging run on an acceptance criterion, and stays at the gate',
    );
    expect(heldBackWarningSentence(held(1), undeclared)).toContain(
      'holding back: it owes an acceptance criterion',
    );
    expect(heldBackWarningSentence(held(1), served, ['grant the read'])).toContain(
      'holding back: it still owes an acceptance criterion',
    );
    expect(heldBackWarningSentence(held(1), served, ['grant the read'])).toContain(
      'Otherwise it stays at the gate',
    );
  });

  it('says each owes and stays, at two', () => {
    expect(heldBackWarningSentence(held(2), served)).toContain(
      'without 2 issues the sweep is holding back: each still owes a judging run',
    );
    expect(heldBackWarningSentence(held(2), served, ['grant the read'])).toContain(
      'Otherwise each stays at the gate',
    );
  });
});

describe('the warning about a roster cut in parts', () => {
  it('says the remaining one waits, at one', () => {
    expect(rosterInPartsWarningSentence(51, 50, 1)).toContain(
      'the remaining 1 waits for a later release',
    );
  });

  it('says the remaining two wait, at two', () => {
    expect(rosterInPartsWarningSentence(52, 50, 2)).toContain(
      'the remaining 2 wait for a later release',
    );
  });
});

describe('live bindings naming different release runners', () => {
  const sentence = (labels: string[]) =>
    releaseBlockerSentence('RELEASE_RUNNER_AMBIGUOUS', { labels });

  it('counts the labels it names, at two', () => {
    expect(sentence(['box-a', 'box-b'])).toContain(
      'Live deploy targets name 2 different release runners (box-a, box-b), so there is no one box',
    );
  });

  it('counts the labels it names, at three, never saying two', () => {
    const three = sentence(['box-a', 'box-b', 'box-c']);
    expect(three).toContain('name 3 different release runners (box-a, box-b, box-c)');
    expect(three).not.toMatch(/\bTwo\b/);
  });
});

// ISS-1229 r11, judge-25: "Every issue at Awaiting release still owes…" was said of one issue.
describe('every issue at Awaiting release still owing a criterion', () => {
  const sentence = (n: number) =>
    releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held: held(n) });

  it('speaks of the one issue, at one', () => {
    expect(sentence(1)).toBe(
      'The one issue at Awaiting release still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each verdict it owes is recorded: `ISS-1` owes criterion 1.',
    );
  });

  it('speaks of both issues, at two', () => {
    expect(sentence(2)).toBe(
      'Both issues at Awaiting release still owe a verdict on an acceptance criterion, so the automatic release cuts nothing until each verdict they owe is recorded: `ISS-1` owes criterion 1; `ISS-2` owes criterion 1.',
    );
  });

  it('counts all of them, from three', () => {
    expect(sentence(3)).toMatch(/^All 3 issues at Awaiting release still owe a verdict/);
  });

  it('keeps the general sentence where it names no issue', () => {
    expect(releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED')).toMatch(/^Every issue at /);
  });
});

describe('every issue at the gate held because nothing can read what the project serves', () => {
  const sentence = (n: number) =>
    releaseBlockerSentence('RELEASE_RUNTIME_UNROUTED', {
      missing: 'no probe',
      held: held(n),
    });

  it('speaks of the one issue, at one', () => {
    const one = sentence(1);
    expect(one).toContain('and the one issue waiting at the gate is held on that one reason');
    expect(one).toContain('the next sweep weighs it again');
    expect(one).not.toMatch(/every (waiting )?issue/);
  });

  it('speaks of both issues, at two', () => {
    const two = sentence(2);
    expect(two).toContain('and both issues waiting at the gate are held on that one reason');
    expect(two).toContain('the next sweep weighs them again');
    expect(two).not.toMatch(/\ball 2\b/i);
  });

  it('counts all of them, from three', () => {
    expect(sentence(3)).toContain(
      'and all 3 issues waiting at the gate are held on that one reason',
    );
  });
});
