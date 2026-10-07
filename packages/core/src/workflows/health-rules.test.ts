import { saidDisagreements, say, verbatim } from '@forge/contracts/said';
import { waitingOn as waitOn } from '@forge/contracts/standing';
import { rewriteThresholdOf } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designDiff } from './design-diff.js';
import { deriveHealth as deriveHealth_, type HealthFacts } from './health-rules.js';
import type { ObservationDocument } from './observation-schema.js';
import type { WorkflowWrite } from './schema.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const deriveHealth = ((...a: Parameters<typeof deriveHealth_>) =>
  checked(deriveHealth_(...a))) as typeof deriveHealth_;

const T0 = new Date('2026-10-01T00:00:00Z');
const T1 = new Date('2026-10-02T00:00:00Z');
const T2 = new Date('2026-10-03T00:00:00Z');
const NOW = new Date('2026-10-05T00:00:00Z');
const SHA = 'b'.repeat(40);
const cite = { kind: 'repo' as const, file: 'src/a.ts', symbol: 'a' };

type Step = WorkflowWrite['steps'][number];
const step = (id: string, after: string[] = [], extra: Partial<Step> = {}): Step => ({
  id,
  does: `${id} does its thing`,
  after,
  ...extra,
});

function design(steps: Step[], edges: { from: string; to: string }[] = []): WorkflowWrite {
  return {
    $schema: 'https://forge.sidcorp.co/schemas/workflow-v2.json',
    version: '2',
    project: '00000000-0000-4000-8000-000000000000',
    flow: 'pilot',
    kind: 'flow',
    title: 'Pilot',
    template: { id: 'service-blueprint-cross-functional', version: 1 },
    steps,
    edges,
  } as unknown as WorkflowWrite;
}

const plan = design(
  [step('intake'), step('check', ['intake']), step('ship', ['check'])],
  [
    { from: 'intake', to: 'check' },
    { from: 'check', to: 'ship' },
  ],
);

function observed(
  steps: { id: string; matches: string | null; does?: string; after?: string[] }[],
  edges: { from: string; to: string }[] = [],
): ObservationDocument {
  return {
    steps: steps.map((s) => ({
      id: s.id,
      matches: s.matches,
      does: s.does ?? `${s.matches ?? s.id} does its thing`,
      after: s.after ?? [],
      evidence: cite,
    })),
    edges: edges.map((e) => ({ ...e, evidence: cite })),
    drift: null,
  } as ObservationDocument;
}

function facts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: NOW,
    workflowId: 'w1',
    flow: 'pilot',
    projectSlug: 'forge',
    head: { revision: 2, document: plan },
    approvedRevision: 2,
    revisions: [{ revision: 2, document: plan, decidedAt: T0 }],
    proposed: null,
    lastProposedAt: T0,
    template: null,
    criteria: [],
    contractPins: [],
    feedback: [],
    suggestions: [],
    builds: [],
    observation: null,
    decisions: [],
    threshold: rewriteThresholdOf(undefined),
    rooted: { rooted: true, approvedRevision: 2, requirements: ['REQ-18'], missing: [] },
    ...over,
  };
}

const obsOf = (document: ObservationDocument, createdAt = T1): HealthFacts['observation'] => ({
  id: 'o1',
  atSha: SHA,
  revision: 2,
  createdAt,
  writtenBy: 'u1',
  writtenByAgency: 'agent',
  document,
});

const fullMatch = observed(
  [
    { id: 'o-intake', matches: 'intake' },
    { id: 'o-check', matches: 'check', after: ['o-intake'] },
    { id: 'o-ship', matches: 'ship', after: ['o-check'] },
  ],
  [
    { from: 'o-intake', to: 'o-check' },
    { from: 'o-check', to: 'o-ship' },
  ],
);

const node = (h: ReturnType<typeof deriveHealth>, key: string) =>
  h.nodes.find(
    (n) => (n.target.kind === 'step' ? `${n.target.layer}:${n.target.step}` : '') === key,
  );

describe('d-provenance', () => {
  it('reads every node planned with no diff marker when the code has not been observed', () => {
    const h = deriveHealth(facts());
    expect(h.observation).toBeNull();
    expect(h.markers).toEqual([]);
    expect(h.nodes.every((n) => n.provenance === 'planned')).toBe(true);
  });

  it('reads an approved step nothing observed matches as Upcoming', () => {
    const h = deriveHealth(
      facts({ observation: obsOf(observed([{ id: 'o-intake', matches: 'intake' }])) }),
    );
    const ship = h.markers.filter((m) => m.target.kind === 'step' && m.target.step === 'ship');
    expect(ship.map((m) => m.kind)).toContain('upcoming');
    expect(node(h, 'planned:ship')?.provenance).toBe('planned');
    expect(node(h, 'planned:ship')?.proposedDecision).toBe('keep');
  });

  it('reads an observed handler with matches null as Not in design, waiting on a person', () => {
    const doc = observed([
      ...fullMatch.steps.map((s) => ({ ...s })),
      { id: 'legacy', matches: null },
    ]);
    const h = deriveHealth(facts({ observation: obsOf({ ...doc, edges: fullMatch.edges }) }));
    const legacy = h.markers.find((m) => m.kind === 'not_in_design');
    expect(legacy?.target).toEqual({ kind: 'step', step: 'legacy', layer: 'observed' });
    expect(legacy?.waitingOn.kind).toBe('person');
    expect(node(h, 'observed:legacy')?.proposedDecision).toBe('delete');
    expect(h.needsYou).toBe(1);
  });

  it('reads a pair whose behaviour and outgoing lines differ as Wrong naming both, due a rewrite', () => {
    const doc = observed(
      [
        { id: 'o-intake', matches: 'intake' },
        { id: 'o-check', matches: 'check', does: 'check does something else', after: ['o-intake'] },
        { id: 'o-ship', matches: 'ship', after: ['o-intake'] },
      ],
      [{ from: 'o-intake', to: 'o-check' }],
    );
    const h = deriveHealth(facts({ observation: obsOf(doc) }));
    const wrong = h.markers.find(
      (m) => m.kind === 'wrong' && m.target.kind === 'step' && m.target.step === 'check',
    );
    expect(wrong?.aspects).toEqual(['behaviour', 'wiring']);
    const check = node(h, 'planned:check');
    expect(check?.rewrite).toBe('due');
    expect(check?.rewriteRule).toBe('rewrite.divergence');
    expect(wrong?.waitingOn.kind).toBe('person');
  });

  it('does not count an undecided Wrong node below the threshold in needs you', () => {
    const doc = observed(
      [
        { id: 'o-intake', matches: 'intake' },
        { id: 'o-check', matches: 'check', does: 'check does something else', after: ['o-intake'] },
        { id: 'o-ship', matches: 'ship', after: ['o-check'] },
      ],
      fullMatch.edges,
    );
    const h = deriveHealth(facts({ observation: obsOf(doc) }));
    expect(node(h, 'planned:check')?.rewrite).toBe('none');
    expect(h.counts.wrong).toBe(1);
    expect(h.needsYou).toBe(0);
  });

  it('reads a fully matching observation as matched with no marker', () => {
    const h = deriveHealth(facts({ observation: obsOf(fullMatch) }));
    expect(h.markers).toEqual([]);
    expect(node(h, 'planned:check')?.provenance).toBe('matched');
  });
});

describe('d-rewrite and d-node-lifecycle', () => {
  const diverged = observed(
    [
      { id: 'o-intake', matches: 'intake' },
      { id: 'o-check', matches: 'check', does: 'other', after: ['o-intake'] },
      { id: 'o-ship', matches: 'ship', after: ['o-intake'] },
    ],
    [{ from: 'o-intake', to: 'o-check' }],
  );
  const decision = (at: Date): HealthFacts['decisions'][number] => ({
    commentId: 'c1',
    node: { step: 'check', verdict: 'rewrite', marker: 'wrong' },
    reason: 'rebuild to the plan',
    by: 'u1',
    byName: 'Owner',
    at,
  });

  it('lets a decision replace due and reads decided, then cleaning while its build is open', () => {
    const decided = deriveHealth(
      facts({ observation: obsOf(diverged, T0), decisions: [decision(T1)] }),
    );
    expect(node(decided, 'planned:check')?.rewrite).toBe('decided_rewrite');
    expect(node(decided, 'planned:check')?.phase).toBe('decided');
    expect(decided.needsYou).toBe(0);

    const cleaning = deriveHealth(
      facts({
        observation: obsOf(diverged, T0),
        decisions: [decision(T1)],
        builds: [
          {
            issueKey: 'ISS-9',
            status: 'in_progress',
            reopenCount: 0,
            updatedAt: T2,
            linkedAt: T2,
            closedAt: null,
            targets: [{ kind: 'step', step: 'check' }],
            observedSteps: [],
            release: null,
            failing: [],
            judgedAgainst: [],
            run: null,
          },
        ],
      }),
    );
    expect(node(cleaning, 'planned:check')?.phase).toBe('cleaning');
  });

  it('reads reconciled once an observation after the close matches the plan', () => {
    const h = deriveHealth(
      facts({
        observation: obsOf(fullMatch, NOW),
        decisions: [decision(T1)],
        builds: [
          {
            issueKey: 'ISS-9',
            status: 'closed',
            reopenCount: 0,
            updatedAt: T2,
            linkedAt: T2,
            closedAt: T2,
            targets: [{ kind: 'step', step: 'check' }],
            observedSteps: [],
            release: null,
            failing: [],
            judgedAgainst: [],
            run: null,
          },
        ],
      }),
    );
    expect(node(h, 'planned:check')?.phase).toBe('reconciled');
    expect(node(h, 'planned:check')?.provenance).toBe('matched');
  });

  it('is due a rewrite after two problem builds inside the window', () => {
    const problem = (key: string): HealthFacts['builds'][number] => ({
      issueKey: key,
      status: 'in_progress',
      reopenCount: 0,
      updatedAt: T2,
      linkedAt: T0,
      closedAt: null,
      targets: [{ kind: 'step', step: 'ship' }],
      observedSteps: [],
      release: null,
      failing: [{ n: 1, reason: 'broken', at: T2 }],
      judgedAgainst: [],
      run: null,
    });
    const h = deriveHealth(facts({ builds: [problem('ISS-1'), problem('ISS-2')] }));
    expect(h.counts.has_problem).toBe(2);
    expect(node(h, 'planned:ship')?.rewriteRule).toBe('rewrite.repeat_problem');
  });
});

describe('evidence markers', () => {
  it('marks a step outdated when its criterion was reworded after the design was approved', () => {
    const h = deriveHealth(
      facts({
        criteria: [
          {
            requirementKey: 'REQ-4',
            code: 'BC-7',
            sinceRevision: 3,
            sinceAcceptedAt: T1,
            targets: [{ kind: 'step', step: 'check' }],
            proof: null,
          },
        ],
      }),
    );
    expect(h.markers).toHaveLength(1);
    expect(h.markers[0]?.rule).toBe('outdated.criterion_reworded');
    expect(h.markers[0]?.reason).toBe('REQ-4 BC-7 reworded in r3 after design r2 was approved');
  });

  it('never marks a step outdated by a wording accepted before the approval', () => {
    const h = deriveHealth(
      facts({
        criteria: [
          {
            requirementKey: 'REQ-4',
            code: 'BC-7',
            sinceRevision: 1,
            sinceAcceptedAt: T0,
            targets: [{ kind: 'step', step: 'check' }],
            proof: null,
          },
        ],
        revisions: [{ revision: 2, document: plan, decidedAt: T1 }],
      }),
    );
    expect(h.markers).toEqual([]);
  });

  it('places feedback naming no step on the workflow, never on a guessed step', () => {
    const waitingOn = waitOn('person', {
      who: say('standing.who.named', { name: 'Triage' }),
      act: verbatim('triage'),
      rule: verbatim('r'),
    });
    const h = deriveHealth(
      facts({
        feedback: [
          {
            key: 'FB-45',
            title: 'breakdown is wrong',
            target: { kind: 'step', step: 'check' },
            waitingOn,
            createdAt: T1,
          },
          { key: 'FB-26', title: 'the whole flow', target: null, waitingOn, createdAt: T1 },
        ],
      }),
    );
    expect(h.markers.find((m) => m.source.key === 'FB-45')?.target).toEqual({
      kind: 'step',
      step: 'check',
      layer: 'planned',
    });
    expect(h.workflowLevel.map((m) => m.source.key)).toEqual(['FB-26']);
    expect(h.needsYou).toBe(2);
  });

  it('marks what a proposed revision removes, changes and orphans', () => {
    const proposedDoc = design(
      [step('intake'), step('check', ['intake'], { does: 'check, reworded' })],
      [{ from: 'intake', to: 'check' }],
    );
    const waitingOn = waitOn('person', {
      who: say('standing.who.named', { name: 'Approver' }),
      act: verbatim('approve'),
      rule: verbatim('r'),
    });
    const h = deriveHealth(
      facts({
        head: { revision: 3, document: proposedDoc },
        revisions: [
          { revision: 2, document: plan, decidedAt: T0 },
          { revision: 3, document: proposedDoc, decidedAt: null },
        ],
        proposed: { revision: 3, document: proposedDoc, proposedAt: T1, waitingOn },
        criteria: [
          {
            requirementKey: 'REQ-4',
            code: 'BC-1',
            sinceRevision: 1,
            sinceAcceptedAt: null,
            targets: [{ kind: 'step', step: 'ship' }],
            proof: null,
          },
        ],
      }),
    );
    const rules = h.markers.map(
      (m) =>
        `${m.rule}:${m.target.kind === 'step' ? m.target.step : m.target.kind === 'edge' ? `${m.target.from}>${m.target.to}` : 'wf'}`,
    );
    expect(rules).toEqual(
      expect.arrayContaining([
        'needs_update.revision_changes:check',
        'remove_proposed.revision:ship',
        'remove_proposed.revision:check>ship',
      ]),
    );
    expect(h.revision).toBe(3);
    expect(h.diff?.steps).toEqual({ check: 'changed', ship: 'removed' });
    expect(h.orphanedTraces).toEqual([
      expect.objectContaining({ recordType: 'requirement_criterion', key: 'REQ-4 BC-1' }),
    ]);
    expect(node(h, 'planned:ship')).toBeDefined();
  });

  it('serves the same source once per kind and target', () => {
    const waitingOn = waitOn('agent', {
      who: say('standing.who.named', { name: 'Master' }),
      act: say('standing.act.none'),
      rule: verbatim('r'),
    });
    const twice = {
      key: 'FB-1',
      title: 't',
      target: { kind: 'step' as const, step: 'check' },
      waitingOn,
      createdAt: T1,
    };
    const h = deriveHealth(facts({ feedback: [twice, twice] }));
    expect(h.markers).toHaveLength(1);
  });
});

describe('bkm-diff', () => {
  it('reads added, changed and removed steps and a rewired line as removed plus added', () => {
    const after = design(
      [step('intake'), step('check', ['intake'], { title: 'Check it' }), step('new')],
      [{ from: 'intake', to: 'new' }],
    );
    const d = designDiff(plan, after);
    expect(Object.fromEntries(d.steps)).toEqual({
      check: 'changed',
      new: 'added',
      ship: 'removed',
    });
    expect(Object.fromEntries(d.edges)).toEqual({
      'intake>check': 'removed',
      'check>ship': 'removed',
      'intake>new': 'added',
    });
  });
});
