// ISS-900, ISS-957: a project whose production names no commit it serves (agenfold,
// `release-is-the-agents-record`) weighs a waiting issue at its landing: the release its record says is
// live cannot hold a change that has not shipped (FB-493). Its hold names the landing commit to judge
// at, never that release nor a source probe the owner's rule rules out; any other project's hold
// names what is served, as before.
// @direct-test-of packages/core/src/release-batch/hold.ts
// @direct-test-of packages/core/src/release-batch/criteria-hold-words.ts

import type { ReleasedLine } from '@forge/contracts/released-line';
import { describe, expect, it } from 'vitest';
import type { IssueCriteriaReport } from '../issues/index.js';
import type { LandingCriteriaReport } from './criteria-basis.js';
import { criteriaHold, landingCriteriaHold } from './criteria-hold-words.js';

const LANDING = 'f4e5fb66700ba7b35c8c607c8f7309fc5980861a';
// ISS-964: the reason is that production moves only by its releases; naming no commit is how it reads
const BY_RECORD = {
  kind: 'landing',
  why: 'release-only',
  landsOn: 'main',
  deploysFrom: 'main',
  byRecord: true,
  deployment: 'on-land',
} as const;

const landed = (afterRelease: number[] = []): LandingCriteriaReport => ({
  issueId: '00000000-0000-4000-8000-000000000002',
  landing: LANDING,
  unearned: [{ criterion: 2, why: 'no verdict was recorded for it' }],
  afterRelease: afterRelease.map((criterion) => ({ criterion, why: 'judged after release' })),
  counted: [],
});

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
  it('names the landing commit to judge at, never the live release that predates the change', () => {
    const held = landingCriteriaHold(landed(), BY_RECORD, 'agent');
    expect(held.reason).toContain('judged at its landing commit `f4e5fb66700b` on `main`');
    expect(held.reason).toContain('names no commit it serves');
    expect(held.reason).not.toContain('0.76.0');
    expect(held.reason).not.toContain('promotion');
    expect(held.reason).not.toContain('declare one');
    expect(held.waitingFor).toBe('a verdict on each criterion named at its landing commit');
    expect(held.criteria).toEqual([2]);
  });

  it('names a live-only criterion as not held, judged after the release', () => {
    const held = landingCriteriaHold(landed([1]), BY_RECORD, 'agent');
    expect(held.reason).toContain('Not held: criterion 1, judged after release.');
    expect(held.criteria).toEqual([2]);
  });

  it('names what is served where production reads the commit it serves, and why it is weighed there', () => {
    const held = criteriaHold(report(null), 'human');
    expect(held.reason).toContain(
      "It is weighed at what this project's production serves, a commit no release shipped",
    );
    expect(held.reason).toContain('declare one');
    expect(held.waitingFor).toBe(
      'a verdict on each criterion named at the running deployment, or the issue closed by hand',
    );
  });
});
