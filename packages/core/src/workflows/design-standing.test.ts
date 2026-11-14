import { GATE_PROFILES } from '@forge/contracts/gate-profiles';
import { PERSON_GATES } from '@forge/contracts/person-gates';
import { saidDisagreements } from '@forge/contracts/said';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf, repinRowOf } from '../development/needs-you-design.js';
import { masterActRefusal } from '../permissions/master-acts.js';
import { buildGateOf, designWaitingOn, masterDecidesDesigns } from './design-standing.js';

// A proposed design resting on a base not approved at the revision it names waits on its writer, and
// says why from the refusal's facts (revision, each base and its fault), never from its English detail.

describe('a proposed design on an unapproved base', () => {
  it('names each base by its fault, said by key so a reader reads it in their language', () => {
    const w = designWaitingOn({
      status: 'proposed',
      proposedRevision: 4,
      approvedRevision: 3,
      latest: { revision: 4, author: 'Lan' },
      canDecide: true,
      masterDecides: false,
      baseUnapproved: {
        revision: 4,
        bases: [
          {
            workflow: 'hop-auth',
            revision: 2,
            state: 'stale',
            approvedRevision: 3,
            designStatus: 'approved',
          },
          {
            workflow: 'hop-cart',
            revision: 1,
            state: 'unapproved',
            approvedRevision: null,
            designStatus: 'draft',
          },
          {
            workflow: 'hop-gone',
            revision: 1,
            state: 'missing',
            approvedRevision: null,
            designStatus: null,
          },
        ],
      },
    });
    expect(w.kind).toBe('agent');
    expect(w.says.rule).toMatchObject({ key: 'designs.rule.baseUnapprovedAt' });
    // ISS-805 c2: the status line names no base by slug and no revision; the approval panel names them
    expect(w.rule).toBe('a design it builds on is not approved at its pin');
    expect(saidDisagreements(w)).toEqual([]);
  });
});

// FB-145: a base proposed at the revision pinned waits on the base's approver, not on the writer
describe('a proposed design on a base proposed at the revision it pins', () => {
  const input = (canDecide: boolean, masterDecides = false) => ({
    status: 'proposed' as const,
    proposedRevision: 1,
    approvedRevision: null,
    latest: { revision: 1, author: 'Lan' },
    canDecide,
    masterDecides,
    baseUnapproved: {
      revision: 1,
      bases: [
        {
          workflow: 'hop-auth',
          revision: 4,
          state: 'proposed' as const,
          approvedRevision: 3,
          designStatus: 'proposed' as const,
        },
      ],
    },
  });

  it('names approving the base as the act, yours where you may approve it', () => {
    const w = designWaitingOn(input(true));
    expect(w.kind).toBe('you');
    expect(w.says.act).toEqual({ key: 'designs.act.approveBase' });
    expect(w.rule).toBe('the designs it builds on are approved first');
    expect(saidDisagreements(w)).toEqual([]);
  });

  it('waits on whoever holds approval where you may not', () => {
    const w = designWaitingOn(input(false));
    expect(w.kind).toBe('person');
    expect(w.says.act.key).toBe('designs.act.approveBase');
  });

  it("names the project's master where it decides designs, whoever reads it (ISS-1158)", () => {
    for (const canDecide of [true, false]) {
      const w = designWaitingOn(input(canDecide, true));
      expect(w).toMatchObject({ kind: 'agent', who: "The project's master" });
      expect(w.says.act.key).toBe('designs.act.approveBase');
    }
  });

  it('still asks the writer to re-pin where another base is stale', () => {
    const mixed = input(true);
    mixed.baseUnapproved.bases.push({
      workflow: 'hop-cart',
      revision: 1,
      state: 'stale' as never,
      approvedRevision: 2,
      designStatus: 'approved' as never,
    });
    const w = designWaitingOn(mixed);
    expect(w.kind).toBe('agent');
    expect(w.says.act.key).toBe('designs.act.repin');
  });
});

// ISS-687 round 4 (judge run d47d6de0 at dev.489, c2 short): Issue lifecycle's page read "Waits on:
// Nobody · nothing next" beside "Needs you 2" and "Approve 4 pin-only changes", while Needs you listed
// "Issue lifecycle · next: decide 2 places where the code and the design differ". An approved design's
// line says what it still owes a person, in the very words Needs you lists it by, and "Nobody" only
// where nothing is owed. Planted red by dropping `owed` from `designWaitingOn`: the line reads Nobody.
describe("an approved design's line agrees with what Needs you counts on it", () => {
  const approved = {
    status: 'approved' as const,
    proposedRevision: null,
    approvedRevision: 20,
    latest: { revision: 20, author: null },
    canDecide: true,
    masterDecides: false,
  };
  const health = {
    flow: 'issue-lifecycle',
    needsYou: 2,
    markers: [],
    proposal: null,
  } as unknown as WorkflowHealth;
  const group = {
    baseId: 'wf-issue-lifecycle',
    flow: 'issue-lifecycle',
    title: 'Issue lifecycle',
    revision: 20,
    ready: ['a', 'b', 'c', 'd'].map((flow, i) => ({
      workflowId: `wf-${flow}`,
      flow,
      source: 'approved' as const,
      revision: 1 + i,
      approves: 2 + i,
      pins: [{ workflow: 'issue-lifecycle', from: 19, to: 20 }],
    })),
    refused: 0,
    approvedAt: '2026-11-04T00:00:00.000Z',
  };

  it('names the places to decide, as the Needs you row on the design does', () => {
    const line = designWaitingOn({
      ...approved,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 2, settleBy: 'person' as const },
    });
    const row = designRowOf(health, 'person')?.standing.waitingOn;
    expect(line).toEqual(row);
    expect(`${line.who} · ${line.act}`).toBe(
      'A person · decide 2 places where the code and the design differ',
    );
    expect(saidDisagreements(line)).toEqual([]);
  });

  // ISS-805 c6 (failed at 1eb3d6c5): six design pages told the QA member "Waiting on you: approve N
  // pin-only changes" while their Needs you counted none, which leaves an act the master takes off a
  // person's list (REQ-68 BC-3). Where the master decides designs, the re-pin waits on the master.
  it('names the master for the pin-only changes where the master decides designs, as Needs you does', () => {
    const owed = {
      flow: 'issue-lifecycle',
      repin: { flow: 'issue-lifecycle', revision: 20, n: 4 },
      settle: 2,
      settleBy: 'master' as const,
    };
    const line = designWaitingOn({ ...approved, owed });
    expect(line.kind).toBe('agent');
    expect(line.act).toBe('approve 4 pin-only changes');
    expect(line).toEqual(repinRowOf(group, true, 'master').standing.waitingOn);
  });

  it('names the pin-only changes first, as the re-pin row on Needs you does', () => {
    const owed = {
      flow: 'issue-lifecycle',
      repin: { flow: 'issue-lifecycle', revision: 20, n: 4 },
      settle: 2,
      settleBy: 'person' as const,
    };
    const line = designWaitingOn({ ...approved, owed });
    expect(line).toEqual(repinRowOf(group, true).standing.waitingOn);
    expect(line.act).toBe('approve 4 pin-only changes');
    // ISS-805 c2 (failed at b13a6b4f): the page's Person view printed this wait as "→ r27"; it names no
    // revision and no flow, which the Developer view's re-pin panel keeps.
    for (const said of [line.who, line.act, line.rule])
      expect(said).not.toMatch(/\br\d+\b|issue-lifecycle/);
  });

  it('reads Nobody · nothing only where nothing is owed, and a step that owes somebody keeps its own wait', () => {
    const none = designWaitingOn({
      ...approved,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 0, settleBy: 'person' as const },
    });
    expect(none.kind).toBe('none');
    const proposed = designWaitingOn({
      ...approved,
      status: 'proposed',
      proposedRevision: 21,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 2, settleBy: 'person' as const },
    });
    expect(proposed.act).toBe('approve or return the design');
  });
});

// ISS-1158 (FB-586): outside strict the master holds workflow-designs.approve, and a proposal read
// "You" to the owner and named no master, so support-group r4 sat proposed for days
describe('a proposed design where the master decides designs', () => {
  const proposed = (canDecide: boolean, masterDecides: boolean) =>
    designWaitingOn({
      status: 'proposed',
      proposedRevision: 4,
      approvedRevision: 3,
      latest: { revision: 4, author: 'Lan' },
      canDecide,
      masterDecides,
    });

  it("waits on the project's master, never on you or a person", () => {
    for (const canDecide of [true, false]) {
      const w = proposed(canDecide, true);
      expect(w).toMatchObject({ kind: 'agent', who: "The project's master" });
      expect(w.act).toBe('approve or return the design');
      expect(w.says.rule).toEqual({ key: 'designs.rule.masterDecides' });
      expect(saidDisagreements(w)).toEqual([]);
    }
  });

  it('waits on you, or on the holders of the approval, where a person decides', () => {
    expect(proposed(true, false).kind).toBe('you');
    expect(proposed(false, false)).toMatchObject({ kind: 'person', who: 'Design approver' });
  });
});

// The read and the pass name the master only where its door takes the approval: whoever decides by
// the one rule, the master's credential is refused nothing there (`master-acts.ts:masterActRefusal`)
describe('whom a proposal names agrees with the approval door', () => {
  const master = { projectId: 'p', role: 'member' as const, grants: [] };
  it.each(
    GATE_PROFILES.flatMap((profile) => [false, true].map((gate) => [profile, gate] as const)),
  )('on a %s project with the designs gate %s', (profile, gate) => {
    const strict = profile === 'strict';
    const gates = Object.fromEntries(PERSON_GATES.map((g) => [g, strict])) as Record<
      (typeof PERSON_GATES)[number],
      boolean
    >;
    const policy = { strict, gates: { ...gates, designs: strict || gate }, releaseApproval: false };
    const door = masterActRefusal(master, 'workflow-designs.approve', { agency: 'agent', profile });
    expect(masterDecidesDesigns(policy)).toBe(!strict && !gate);
    if (masterDecidesDesigns(policy)) expect(door).toBeNull();
    if (strict) expect(door?.code).toBeDefined();
  });
});

// ISS-805 c2 failed three times on what a design page's Person view prints from core: the repin
// banner ("→ r27"), then the Waits on hover ("revision 13 is approved"). Every line a design's
// standing or build gate says names no revision number and no flow slug; the Developer view keeps
// them where the page shows them itself. Planted red by the keys before ISS-805 (`revision {r} is ...`).
describe("a design's standing and build gate name no revision and no flow", () => {
  const base = { workflow: 'hop-auth', revision: 4, approvedRevision: 3, designStatus: null };
  const at = (
    status: 'proposed' | 'returned' | 'draft' | 'approved' | 'withdrawn',
    extra = {},
  ) => ({
    status,
    proposedRevision: 27,
    approvedRevision: 26,
    latest: { revision: 27, author: 'Lan' },
    canDecide: true,
    masterDecides: false,
    ...extra,
  });
  const waits = [
    designWaitingOn(at('proposed')),
    designWaitingOn(at('proposed', { masterDecides: true })),
    designWaitingOn(at('proposed', { canDecide: false })),
    designWaitingOn(
      at('proposed', {
        baseUnapproved: { revision: 27, bases: [{ ...base, state: 'proposed' as const }] },
      }),
    ),
    designWaitingOn(
      at('proposed', {
        baseUnapproved: { revision: 27, bases: [{ ...base, state: 'stale' as const }] },
      }),
    ),
    designWaitingOn(at('returned')),
    designWaitingOn(at('draft')),
    designWaitingOn(at('approved')),
    designWaitingOn(at('withdrawn')),
  ];
  it.each(waits.map((w, i) => [i, w] as const))('wait %i', (_, w) => {
    for (const said of [w.who, w.act, w.rule])
      expect(said).not.toMatch(/\br\d+\b|revision \d|\b(26|27|4)\b|hop-auth/);
  });
  it('the build gate, open and held', () => {
    for (const head of [at('approved'), at('proposed')])
      expect(buildGateOf(head).rule).not.toMatch(/\br\d+\b|revision \d|\b(26|27)\b/);
  });
});
