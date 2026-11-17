/**
 * ISS-709 (judge K104 at f8baad1): a release recorded from a landing on release/stg, on a project that
 * declares production on main and asks no approval, read done, "Shipped", waiting on nobody, and said
 * there was no production. Production does not serve it: whoever cuts releases promotes it.
 *
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 */
import type { ReleasedLine } from '@forge/contracts/released-line';
import { describe, expect, it } from 'vitest';
import type { ReleaseFacts } from './release-facts.js';
import { releaseOwesOf } from './release-owes.js';
import { type Part, type Shared, summaryOf } from './release-read-views.js';
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

// ISS-1280: the master reads its releases as an agent; a release none of whose open criteria a judge
// can reach is never its act, so `master-owed-acts.ts:releaseActsOwed` keeps no pane for it
describe('a landed release whose every open criterion is recorded skipped', () => {
  const skipped = (agency: 'human' | 'agent', admins: string[]) =>
    turnOf({
      state: 'landed',
      version: '0.11.0',
      projectId: 'p1',
      runId: 'r1',
      merges: null,
      landedOn: 'release/stg',
      required: true,
      production: true,
      approval: null,
      approvers: [{ id: 'u2', name: 'Bea', kind: 'human' }],
      admins,
      owes: releaseOwesOf(POLICY(false), []),
      viewer: { userId: 'u', agency, isAdmin: true, mayApprove: true },
      gates: [],
      inFlight: null,
      testing: {
        environment: 'stg',
        judge: null,
        proven: 0,
        total: 2,
        unreached: ['stg serves 1.23.0, not 03b88cbcb8f2', 'stg serves 1.23.0, not 03b88cbcb8f2'],
      },
    });

  it('waits on the admins to add what the skips name, never on the master', () => {
    const turn = skipped('agent', ['Ada']);
    expect(turn.waitingOn).toMatchObject({
      kind: 'person',
      act: 'add what the skips on 0.11.0 name missing',
      rule: 'Every open criterion skipped, no route on stg: stg serves 1.23.0, not 03b88cbcb8f2',
    });
    expect(turn.waitingOn.who).toContain('Ada');
  });

  it('is stuck, naming the permission, where nobody holds project.admin', () => {
    expect(skipped('agent', []).waitingOn).toMatchObject({ kind: 'none' });
  });
});

// ISS-1288, FB-713: adminhub-fe 0.52.0 landed on release/stg in October; a later release production
// serves carries its work, yet it still asked an approver to "review 0.52.0 and promote it to
// production", which would put an older build over the one live. Read through the release read,
// so the line it is read from (`released-line.ts:servedThrough`) is the one under test.
describe('a landed release whose work a later production release carries', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day));
  // 0.52.0 landed off production; 0.60.0 shipped on it after, carrying 0.52.0; 0.61.0 landed after
  // 0.60.0 at a higher version, so nothing production serves carries it
  const LINE: ReleasedLine = {
    why: 'its production `prod` declares no source probe',
    live: { version: '0.60.0', at: at(20) },
    shipped: new Map([
      ['0.52.0', { at: at(5), carried: true, carries: [] }],
      ['0.60.0', { at: at(20), carried: true, carries: ['0.52.0'] }],
      ['0.61.0', { at: at(25), carried: false, carries: ['0.52.0', '0.60.0'] }],
    ]),
  };
  const facts = (released: ReleasedLine | null): ReleaseFacts => ({
    issues: new Map(),
    requirements: new Map(),
    cutters: new Map(),
    judge: null,
    judgedOn: null,
    released,
    landing: null,
    served: null,
  });
  const landedPart = (version: string): Part => ({
    version,
    runId: `run-${version}`,
    state: 'landed',
    issueIds: [],
    openedAt: at(1),
    releasedAt: at(5),
    attempts: [],
    approvals: [],
    gates: [],
    verification: null,
    commit: null,
    cuts: [],
    continuedAs: null,
    naming: null,
    mergeSteps: null,
    landedOn: 'release/stg',
    shippedFailing: null,
    unapproved: null,
    tag: null,
    draftApproval: null,
    draftDecidable: false,
  });
  const shared = (required: boolean, released: ReleasedLine | null = LINE): Shared => ({
    projectId: 'p1',
    ownerDeploys: false,
    current: '0.60.0',
    required,
    production: true,
    viewer: { userId: 'u1', agency: 'human', isAdmin: true, mayApprove: true },
    approvers: [{ id: 'u1', name: 'Bea', kind: 'human' }],
    admins: ['Bea'],
    policy: POLICY(false),
    facts: facts(released),
    contentLanguage: 'en',
    provider: null,
    changeRequestLinks: [],
  });

  it('reads done naming the release production serves it through, and asks no one to promote it', () => {
    for (const required of [true, false]) {
      const s = summaryOf(landedPart('0.52.0'), shared(required));
      expect(s.waitingOn).toMatchObject({
        kind: 'none',
        who: 'Nobody',
        rule: 'landed on release/stg; production serves it through 0.60.0',
      });
      expect(s.attentionGroup).toBe('done');
      expect(s.waitingOn.act).not.toContain('promote');
    }
  });

  it('still asks its approver, or its cutter, where no later production release carries it', () => {
    const asked = summaryOf(landedPart('0.61.0'), shared(true));
    expect(asked.attentionGroup).not.toBe('done');
    expect(asked.waitingOn).toMatchObject({
      kind: 'you',
      act: 'review 0.61.0 and promote it to production',
    });
    // no approval asked: its cutter, here the master, promotes it
    expect(summaryOf(landedPart('0.61.0'), shared(false)).waitingOn).toMatchObject({
      kind: 'agent',
      act: 'review 0.61.0 and promote it to production',
    });
    // a project whose production reads the commit it serves reads no line: today's turn stands
    expect(summaryOf(landedPart('0.52.0'), shared(true, null)).waitingOn).toMatchObject({
      act: 'review 0.52.0 and promote it to production',
    });
  });
});
