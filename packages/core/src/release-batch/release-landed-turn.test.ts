/**
 * ISS-709 (judge K104 at f8baad1): a release recorded from a landing on release/stg, on a project that
 * declares production on main and asks no approval, read done, "Shipped", waiting on nobody, and said
 * there was no production. Production does not serve it: whoever cuts releases promotes it.
 *
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 */
import { describe, expect, it } from 'vitest';
import { releaseOwesOf } from './release-owes.js';
import { turnOf } from './release-view.js';

const POLICY = (strict: boolean) => ({
  strict,
  gates: {
    agree: false,
    revisions: false,
    breakdown: false,
    admit: false,
    accept: false,
    designs: false,
    triage: true,
  },
  releaseApproval: false,
});

const landed = (production: boolean, masterCuts: boolean, isAdmin = false) =>
  turnOf({
    state: 'landed',
    version: '0.1.0',
    projectId: 'p1',
    runId: 'r1',
    merges: null,
    landedOn: 'release/stg',
    required: false,
    production,
    approval: null,
    approvers: [],
    admins: ['Ada'],
    owes: releaseOwesOf(POLICY(!masterCuts), []),
    viewer: { userId: 'u', agency: 'human', isAdmin, mayApprove: false },
    gates: [],
    inFlight: null,
    testing: null,
  });

describe('a release landed off production, with no approval asked', () => {
  it('is done where the project declares no production: the landing is its delivery', () => {
    const turn = landed(false, true);
    expect(turn.attentionGroup).toBe('done');
    expect(turn.waitingOn.rule).toContain('no production and no approval asked');
  });

  it('names the master as who promotes it where production is declared and the master cuts', () => {
    const turn = landed(true, true);
    expect(turn.attentionGroup).toBe('waiting');
    expect(turn.waitingOn).toMatchObject({
      kind: 'agent',
      rule: 'landed on release/stg; production serves it once it is promoted',
    });
  });

  it('names the admins, or the admin reading it, where a person cuts', () => {
    expect(landed(true, false).waitingOn).toMatchObject({ kind: 'person' });
    expect(landed(true, false).waitingOn.who).toContain('Ada');
    // an admin reading it is named as who acts; a promotion is no decision, so it is not Needs you
    expect(landed(true, false, true).waitingOn).toMatchObject({ kind: 'you' });
    expect(landed(true, false, true).attentionGroup).not.toBe('done');
  });
});
