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
  runnerPreferenceUnmetSentence,
} from './blocker-sentences.js';
import type { ServingReading } from './serving-reading.js';

function hold(over: Partial<RunnerHold> = {}): RunnerHold {
  return { deviceName: 'dev1', reason: 'retired', lastSeenSeconds: 13, reporting: true, ...over };
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
      runners: [hold({ deviceName: 'sid-xeon-1', detail: 'draining' })],
    });

    expect(message).toContain('sid-xeon-1');
    expect(message).toContain('draining');
    expect(message).toContain('Takes jobs from the pool');
  });

  it('no longer sends the operator after a box that is up', () => {
    const message = releaseBlockerSentence('NO_RUNNER_ONLINE', {
      runners: [
        hold({ deviceName: 'dev1', detail: 'draining', lastSeenSeconds: 13 }),
        hold({ deviceName: 'sid-xeon-1', detail: 'disabled', lastSeenSeconds: 21 }),
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

describe('the release runner label', () => {
  // ISS-1275's judge read this sentence against the product and found the box it
  // named holding nothing: the label is matched against `runners.labels`, and on
  // a Coolify project Forge holds the deploy credential and makes the call
  // itself. The destination was right and the noun was not.
  it('sends the operator to the box a release runs on, and to the tab that labels it', () => {
    const message = runnerPreferenceUnmetSentence('release');

    expect(message).toContain("Label the box you want this project's releases to run on");
    expect(message).toContain('Settings \u2192 Runners');
    expect(message).not.toContain('the box that holds the deploy credential');
  });

  // The act this repair added was offered for a round with no destination at
  // all. Each act names its screen or the operator is told to do a thing the
  // product has nowhere to do.
  it('names the screen each of the two acts is taken on', () => {
    const message = runnerPreferenceUnmetSentence('release');

    expect(message).toContain(
      'clear `releaseRunnerLabel` from the production deploy binding under Settings \u2192 Integrations',
    );
    expect(message).toContain(
      'from the connection behind it under Integrations in the workspace rail',
    );
  });

  // `and this reading goes with the label` named nothing a reader could point
  // at on the screen it is printed on. What goes away is the warning.
  it('names the warning as the thing that goes away, not `this reading`', () => {
    const message = runnerPreferenceUnmetSentence('release');

    expect(message).toContain('this warning goes with the label');
    expect(message).not.toContain('this reading');
  });

  // ISS-1127 made this sentence state what withdrawing the label cost, because
  // withdrawing it raised a 409. ISS-1275 removed that 409, so the cost clause
  // is gone rather than reworded: a warning naming a consequence nobody meets
  // is the same defect the clause was added to answer, pointed the other way.
  it('names no cost for a withdrawal that now costs nothing', () => {
    const message = runnerPreferenceUnmetSentence('release');

    expect(message).not.toContain('does stop a release');
    expect(message).not.toContain('RELEASE_RUNNER_UNDECLARED');
  });

  it('still sends the operator to the box rather than round the loop', () => {
    const message = runnerPreferenceUnmetSentence('release');

    expect(message).toContain('so this release goes to the pool this project has');
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

  // It said 'Nothing but the issue's own record moves it' and then 'Its status
  // control carries the same move', which read cold is the control refusing and
  // the control doing it. One answer, or the reader picks (ISS-1127).
  it('gives one account of the move rather than two that read against each other', () => {
    for (const details of [{ nearGate: 11 }, { nearGate: 0 }]) {
      const message = releaseBlockerSentence('RELEASE_ROSTER_EMPTY', details);

      expect(message).not.toContain("Nothing but the issue's own record moves it");
      expect(message).toContain('once its own record earns it');
      expect(message).toContain('With those written');
    }
  });
});

describe('a box taken out of the pool', () => {
  it('names the status that was read rather than who is supposed to have set it', () => {
    const clause = runnerHoldClause(hold({ reason: 'retired', detail: 'disabled' }));

    expect(clause).toContain('`disabled`');
    expect(clause).not.toContain('by an operator');
  });
});

describe('the criteria hold', () => {
  const held = [
    { issueId: 'e5f0-uuid-a', displayId: 'ISS-1127', criteria: [3, 7] },
    { issueId: 'e5f0-uuid-b', displayId: 'ISS-1142', criteria: [1] },
  ];

  it('names each held issue and the criteria it owes', () => {
    const message = releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held });

    expect(message).toContain('ISS-1127` owes criterion 3, 7');
    expect(message).toContain('ISS-1142` owes criterion 1');
  });

  const served: ServingReading = { kind: 'serving', served: [], unread: [], readAt: 'now' };

  it('says a release will still be cut where only some are held', () => {
    expect(heldBackWarningSentence(held, served)).toContain('A release will still be cut');
    expect(heldBackWarningSentence(held, served)).toContain('ISS-1142` owes criterion 1');
  });
});

// ISS-1346 judge r2 finding 1: with rows owing nothing beside rows no run can clear, the card told
// a person to dispatch a judging run on a project no verdict can be weighed on.
describe('the held-back warning where nothing can read what the project serves', () => {
  const held = [{ issueId: 'u-3', displayId: 'ISS-3', criteria: [1] }];
  const missing = 'its deploy bindings go through epodsystem, and none of them reports the commit';
  const route = 'declare `verify.probes` on the live deploy binding';
  const sentence = heldBackWarningSentence(held, { kind: 'undeclared', missing, route });

  it('names the missing piece and the route', () => {
    expect(sentence).toContain(`What is missing: ${missing}.`);
    expect(sentence).toContain(`The way to give it one: ${route}.`);
  });

  it('says no judging run earns those criteria until the project can be read', () => {
    expect(sentence).toContain('no judging run can earn one until the project can be read');
    expect(sentence).not.toContain('still owes a judging run');
  });
});

describe('the codes this change did not touch', () => {
  it('keeps counting the issues named in a record refusal', () => {
    expect(
      releaseBlockerSentence('RELEASE_RECORD_MISSING', { issueIds: ['a', 'b', 'c'] }),
    ).toContain('3 issue(s)');
  });

  // ISS-1346 judge r2 finding 2: "2 issue(s) named here have no release note", naming neither.
  it('names each issue a record refusal is about by its display id', () => {
    const details = { issueIds: ['a', 'b'], displayIds: ['ISS-1', 'ISS-2'] };
    expect(releaseBlockerSentence('RELEASE_RECORD_MISSING', details)).toContain(
      '2 issue(s) named here (`ISS-1`, `ISS-2`) have no release note',
    );
    expect(releaseBlockerSentence('RELEASE_WORK_UNMERGED', details)).toContain(
      '2 issue(s) named here (`ISS-1`, `ISS-2`) have no merge',
    );
    expect(
      releaseBlockerSentence('RELEASE_WORK_UNMERGED', { ...details, shape: 'outside_git' }),
    ).toContain('2 issue(s) named here (`ISS-1`, `ISS-2`) have no mark');
  });

  it('keeps naming the check that could not be run', () => {
    expect(releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', { check: 'channels' })).toContain(
      'The `channels` check could not be run',
    );
  });
});

// ISS-1322's judge read this one in the release dialog as "an agent `closed` here is already
// `closed` … or leave it empty": a status named twice and a remedy that is the state it is in.
describe('NO_RELEASE_GATE — what it means for the issues named', () => {
  const sentence = releaseBlockerSentence('NO_RELEASE_GATE');

  it('says that on this project closing an issue is what ships it', () => {
    expect(sentence).toMatch(/closing an issue is what ships it/);
    expect(sentence).toMatch(/Close these issues to ship them/);
  });

  it('names no status in a code span and offers no remedy that is the state it is in', () => {
    expect(sentence).not.toContain('`');
    expect(sentence).not.toMatch(/already closed|leave it empty/i);
  });

  it('names where releasing through Forge is set up, both halves of it', () => {
    expect(sentence).toMatch(/declare a production environment with a deploy binding/);
    expect(sentence).toMatch(/project document, written with PUT \/api\/projects\/:id\/config/);
  });
});

// ISS-1346 judge finding 4 — mowment, bound through epodsystem, was told to deploy through Coolify.
describe('what RELEASE_RUNTIME_UNROUTED tells a project nothing can read', () => {
  const route =
    'declare a runtime probe identifying the source on the production environment, naming an ' +
    'address of this project that answers with the commit it is serving';
  const held = [
    { issueId: 'u-51', displayId: 'ISS-51', criteria: [1, 2] },
    { issueId: 'u-52', displayId: 'ISS-52', criteria: [3] },
  ];
  const sentence = releaseBlockerSentence('RELEASE_RUNTIME_UNROUTED', {
    missing: 'its deploy bindings go through epodsystem, and none of them reports the commit',
    route,
    held,
  });

  it('names the route the reading gave it, and no provider it cannot become', () => {
    expect(sentence).toContain(`The way to give it one: ${route}.`);
    expect(sentence).not.toMatch(/Coolify/);
  });

  it('names each held issue by its display id and what it owes, not a count', () => {
    expect(sentence).toContain('`ISS-51` owes criterion 1, 2; `ISS-52` owes criterion 3.');
    expect(sentence).not.toContain('Held:');
  });
});
