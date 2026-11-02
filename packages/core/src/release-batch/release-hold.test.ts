// ISS-900: a project whose production names no commit it serves (agenfold, `release-is-the-agents-record`)
// weighs an issue's verdicts on its agent's release record. Its criteria hold names the release to judge
// on, on the issue, never a source probe the owner's rule rules out; any other project's hold names
// what is served, as before.
// @direct-test-of packages/core/src/release-batch/hold.ts

import type { ReleasedLine } from '@forge/contracts/released-line';
import { describe, expect, it } from 'vitest';
import type { IssueCriteriaReport } from '../issues/index.js';
import { criteriaHold } from './hold.js';

const line: ReleasedLine = {
  why: "its production `production` declares no source probe, so no commit is read for what it serves: its releases are its agent's record by version",
  live: { version: '0.76.0', at: new Date('2026-11-02T00:00:00Z') },
  shipped: new Map([['0.76.0', { at: new Date('2026-11-02T00:00:00Z'), carried: true }]]),
};

const report = (released: ReleasedLine | null): IssueCriteriaReport => ({
  issueId: '00000000-0000-4000-8000-000000000001',
  unearned: [
    {
      criterion: 1,
      verdict: 'pass',
      standing: 'unwitnessed',
      why: 'judged against source f4e5fb66700b',
      runtime: null,
      environment: null,
      undecided: false,
    },
  ],
  earned: [],
  broken: [],
  serving: {
    kind: 'undeclared',
    missing: 'production declares no source probe',
    route: 'declare one',
  },
  weighedOn: null,
  runtimes: [],
  uncorroborated: [],
  released,
});

describe('the criteria hold where verdicts count on a release', () => {
  it('names the live release to judge on, on the issue, and no probe', () => {
    const held = criteriaHold(report(line), 'agent');
    expect(held.reason).toContain(
      "judge it on release 0.76.0, naming `{ kind: 'release', version: '0.76.0' }` on the issue",
    );
    expect(held.reason).not.toContain('declare one');
    expect(held.waitingFor).toBe('a verdict on each criterion named on the live release');
  });

  it('names the release record to make, and how, where none is recorded: never a probe', () => {
    const held = criteriaHold(report({ ...line, live: null, shipped: new Map() }), 'agent');
    expect(held.reason).toContain(
      'record the release production serves (POST /api/projects/:id/release-records',
    );
    expect(held.reason).not.toContain('declare one');
    expect(held.waitingFor).toBe(
      'the release production serves recorded, then a verdict on each criterion named on it',
    );
  });

  it('names what is served where production reads the commit it serves', () => {
    const held = criteriaHold(report(null), 'human');
    expect(held.reason).toContain('declare one');
    expect(held.waitingFor).toBe(
      'a verdict on each criterion named at the running deployment, or the issue closed by hand',
    );
  });
});
