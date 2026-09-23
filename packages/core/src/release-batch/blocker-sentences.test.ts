/**
 * The sentences themselves, which nothing tested before.
 *
 * ISS-1127 shipped an enumerator whose codes and ordering were right and whose
 * wording pointed away from the act: `NO_RUNNER_ONLINE` told an operator to
 * bring a box up while both of theirs were green and `draining`, and
 * `RELEASE_ROSTER_EMPTY` told them to merge and mark eleven issues they had
 * already merged and marked. Every criterion passed, because each asked whether
 * the code was in the list and none asked what the sentence said.
 *
 * So what is asserted here is the sentence: that it names the state the check
 * read, that it names an act, and that it does not name an act that would not
 * work.
 */

import { describe, expect, it } from 'vitest';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';
import {
  heldBackWarningSentence,
  releaseBlockerSentence,
  runnerHoldClause,
} from './blocker-sentences.js';

function hold(over: Partial<RunnerHold> = {}): RunnerHold {
  return { name: 'dev1', reason: 'retired', lastSeenSeconds: 13, reporting: true, ...over };
}

const EVERY_READING: RunnerHoldReason[] = [
  'device-disabled',
  'retired',
  'never-connected',
  'disconnected',
  'stale',
  'auth',
  'rate-limited',
  'quarantined',
  'provisioning',
  'below-floor',
];

describe('NO_RUNNER_ONLINE', () => {
  it('names the box, the state and the switch that returns it', () => {
    const message = releaseBlockerSentence('NO_RUNNER_ONLINE', {
      runners: [hold({ name: 'sid-xeon-1', detail: 'draining' })],
    });

    expect(message).toContain('sid-xeon-1');
    expect(message).toContain('draining');
    expect(message).toContain('Takes jobs from the pool');
  });

  it('no longer sends the operator after a box that is up', () => {
    const message = releaseBlockerSentence('NO_RUNNER_ONLINE', {
      runners: [
        hold({ name: 'dev1', detail: 'draining', lastSeenSeconds: 13 }),
        hold({ name: 'sid-xeon-1', detail: 'disabled', lastSeenSeconds: 21 }),
      ],
    });

    expect(message).not.toContain('Bring one up');
    expect(message).not.toContain('wait for one to reconnect');
    expect(message).toContain('dev1');
    expect(message).toContain('sid-xeon-1');
  });

  it('says a retired box is up and reporting only while it is', () => {
    const reporting = runnerHoldClause(hold({ reporting: true, lastSeenSeconds: 13 }));
    const silent = runnerHoldClause(hold({ reporting: false, lastSeenSeconds: 400 }));

    expect(reporting).toContain('up and reporting');
    expect(silent).not.toContain('reporting');
    expect(silent).toContain('400s ago');
  });

  it('gives every reading an act or the condition it waits out, and no two share one', () => {
    const clauses = EVERY_READING.map((reason) => runnerHoldClause(hold({ reason })));

    expect(new Set(clauses).size).toBe(EVERY_READING.length);
    for (const clause of clauses) expect(clause.length).toBeGreaterThan(40);
  });

  it.each([
    ['device-disabled' as const, 'Re-enable that device'],
    ['retired' as const, 'Takes jobs from the pool'],
    ['never-connected' as const, 'Start `forge-runner`'],
    ['disconnected' as const, 'Start `forge-runner`'],
    ['stale' as const, 'still running'],
    ['auth' as const, 'Re-authenticate'],
    ['rate-limited' as const, 'wait it out'],
    ['quarantined' as const, 'clear the quarantine'],
    ['provisioning' as const, 're-run'],
    ['below-floor' as const, 'Upgrade `forge-runner`'],
  ])('%s names what to do about it', (reason, act) => {
    expect(runnerHoldClause(hold({ reason }))).toContain(act);
  });

  it('falls back to a sentence about the Runners tab where no reading was taken', () => {
    const message = releaseBlockerSentence('NO_RUNNER_ONLINE', { runners: [] });

    expect(message).toContain('Takes jobs from the pool');
    expect(message).not.toContain('Bring one up');
  });
});

describe('RELEASE_ROSTER_EMPTY', () => {
  it('counts what stands one move short of the gate and names the move', () => {
    const message = releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 11 });

    expect(message).toContain('11 issues');
    expect(message).toContain('`testing`');
    expect(message).toContain('`tested`');
    expect(message).toContain('`awaiting_release`');
  });

  it('no longer says an issue reaches the gate by being merged and marked', () => {
    for (const details of [{ nearGate: 11 }, { nearGate: 0 }, undefined]) {
      expect(releaseBlockerSentence('RELEASE_ROSTER_EMPTY', details)).not.toContain(
        'merged and marked',
      );
    }
  });

  it('says so where nothing stands one move short either', () => {
    expect(releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 0 })).toContain(
      'nothing stands one move short',
    );
  });

  it('reads as one issue rather than 1 issues', () => {
    expect(releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 1 })).toContain('1 issue ');
  });

  it('names the act that moves an issue there, not only the status it must reach', () => {
    for (const details of [{ nearGate: 11 }, { nearGate: 0 }]) {
      const message = releaseBlockerSentence('RELEASE_ROSTER_EMPTY', details);

      expect(message).toContain('verification');
      expect(message).not.toContain('is an act of its own');
    }
  });
});

describe('the criteria hold', () => {
  const held = [
    { issueId: 'ISS-1127', criteria: [3, 7] },
    { issueId: 'ISS-1142', criteria: [1] },
  ];

  it('names each held issue and the criteria it owes', () => {
    const message = releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held });

    expect(message).toContain('ISS-1127` owes criterion 3, 7');
    expect(message).toContain('ISS-1142` owes criterion 1');
  });

  it('says a release will still be cut where only some are held', () => {
    expect(heldBackWarningSentence(held)).toContain('A release will still be cut');
    expect(heldBackWarningSentence(held)).toContain('ISS-1142` owes criterion 1');
  });
});

describe('the codes this change did not touch', () => {
  it('keeps counting the issues named in a record refusal', () => {
    expect(
      releaseBlockerSentence('RELEASE_RECORD_MISSING', { issueIds: ['a', 'b', 'c'] }),
    ).toContain('3 issue(s)');
  });

  it('keeps naming the check that could not be run', () => {
    expect(releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', { check: 'channels' })).toContain(
      'The `channels` check could not be run',
    );
  });
});
