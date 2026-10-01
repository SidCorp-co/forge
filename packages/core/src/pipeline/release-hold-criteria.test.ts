/**
 * ISS-1368 — a criteria hold names the runtimes its issue owes and no other, the route of a declared
 * runtime nothing reports, and, where the criteria could not be weighed, which read failed.
 */

import { describe, expect, it } from 'vitest';
import type { ServingReading } from '../release-batch/serving-reading.js';
import { WeighingUnreadable } from '../release-batch/weighing-unreadable.js';
import { criteriaUnreadableHold, unreadableHoldOf } from './release-hold.js';
import { criteriaHold } from './release-hold-criteria.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const HOST = 'https://app.test/build-info';
const READ_AT = '2026-09-26T23:55:00.000Z';

const live = (readAt = READ_AT): ServingReading => ({
  kind: 'serving',
  served: [{ commit: SERVING, where: HOST }],
  unread: [],
  readAt,
});

const REPORT = {
  issueId: 'iss-1',
  broken: [],
  serving: live(),
  owed: { deployment: true, declared: [], unread: null },
  uncorroborated: [],
  unearned: [{ criterion: 1, verdict: 'pass', standing: 'superseded' as const, why: 'moved on' }],
};

const runtime = (serving: ServingReading) => ({
  name: 'runner',
  paths: ['packages/runner'],
  serving,
});

describe('the hold beside a declared runtime (ISS-1368)', () => {
  it('names a declared runtime beside an unreadable deployment, and does not let it earn unchecked', () => {
    const why = 'runner device box reports no build commit';
    const runner = { kind: 'unreadable' as const, why, hosts: ['box'], readAt: READ_AT };
    const reason = criteriaHold({
      ...REPORT,
      serving: { kind: 'unreadable', why: 'down', hosts: [HOST], readAt: READ_AT },
      owed: { deployment: true, declared: [runtime(runner)], unread: null },
    }).reason;
    expect(reason).toContain(
      'A criterion held in a declared runtime earns only at a build it is running',
    );
    expect(reason).toContain(
      `the \`runner\` runtime, under \`packages/runner\`: nothing could be read`,
    );
    expect(reason).toContain(why);
  });

  it('names no declared runtime the issue does not owe, though one reads nothing', () => {
    const runner = {
      kind: 'unreadable' as const,
      why: 'no build',
      hosts: ['box'],
      readAt: READ_AT,
    };
    const hold = criteriaHold({
      ...REPORT,
      owed: { deployment: true, declared: [], unread: null },
    });
    expect(hold.reason).not.toContain('`runner`');
    expect(hold.reason).not.toContain(runner.why);
    expect(hold.waitingFor).toBe(
      'a verdict on each criterion named at the running deployment, or the issue closed by hand',
    );
  });

  it('names only the declared runtime where the deployment is not owed', () => {
    const runner = live();
    const hold = criteriaHold({
      ...REPORT,
      owed: { deployment: false, declared: [runtime(runner)], unread: null },
    });
    expect(hold.reason).toContain('judged at a build the `runner` runtime is running');
    expect(hold.reason).not.toContain('the deployment');
    expect(hold.waitingFor).not.toContain('deployment');
    expect(hold.waitingFor).toContain('runners reporting a build that carries the change');
  });

  it('carries the route of a declared runtime nothing reports', () => {
    const hold = criteriaHold({
      ...REPORT,
      owed: {
        deployment: false,
        declared: [
          runtime({
            kind: 'undeclared',
            missing: 'no runner device of this project is online to report the build it runs',
            route: 'bring one of this project’s runners online',
          }),
        ],
        unread: null,
      },
    });
    expect(hold.reason).toContain(
      'bring one of this project’s runners online on a build that carries this change, and the next sweep weighs it again with no new verdict',
    );
  });
});

describe('the hold where the criteria could not be read (ISS-1368)', () => {
  it.each([
    [
      'declaration',
      /^This project's stored release runtimes declaration could not be read/,
      'release runtimes declaration',
    ],
    [
      'configuration',
      /^This project's stored pipelineConfig is refused/,
      'stored `pipelineConfig`',
    ],
    ['runners', /^The runner devices/, 'runner devices'],
    ['repository', /^This project's repository binding/, 'repository binding'],
    ['serving', /^What this project is serving could not be read/, 'serving'],
    ['verdicts', /^The verdicts on this issue could not be read/, 'verdicts'],
  ] as const)('opens on the %s and waits for it', (subject, opens, waits) => {
    const hold = criteriaUnreadableHold(subject, 'it failed');
    expect(hold.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    expect(hold.reason).toMatch(opens);
    expect(hold.reason).toContain(': it failed.');
    expect(hold.waitingFor).toContain(waits);
  });
});

describe('which read a criteria hold says failed (ISS-1368)', () => {
  it('takes the subject a weighing names over the stage it threw at', () => {
    const err = new WeighingUnreadable(
      'runners',
      "this project's runner devices could not be read: reset",
    );
    const hold = unreadableHoldOf(err, 'verdicts');
    expect(hold.reason).toMatch(/^The runner devices/);
    expect(hold.reason).toContain('could not be read: reset');
  });

  it('names the stage for any other failure', () => {
    expect(unreadableHoldOf(new Error('db down'), 'serving').reason).toMatch(
      /^What this project is serving could not be read/,
    );
    expect(unreadableHoldOf('timeout', 'verdicts').reason).toMatch(/^The verdicts.*: timeout\./);
  });
});
