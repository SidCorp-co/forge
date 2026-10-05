import { rewriteThresholdOf } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { deriveHealth, type HealthFacts } from './health-rules.js';
import type { ObservationDocument } from './observation-schema.js';
import type { WorkflowWrite } from './schema.js';

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

describe('d-node-lifecycle on the observed layer, and the reconciliation read', () => {
  const extra = observed([
    { id: 'o-intake', matches: 'intake' },
    { id: 'o-check', matches: 'check', after: ['o-intake'] },
    { id: 'o-ship', matches: 'ship', after: ['o-check'] },
    { id: 'o-extra', matches: null, after: ['o-check'] },
  ]);
  const deleteIt = (at: Date): HealthFacts['decisions'][number] => ({
    commentId: 'c2',
    node: { step: 'o-extra', verdict: 'delete', layer: 'observed', marker: 'not_in_design' },
    reason: 'the plan holds no such step',
    by: 'u1',
    byName: 'Owner',
    at,
  });
  const build = (
    over: Partial<HealthFacts['builds'][number]> = {},
  ): HealthFacts['builds'][number] => ({
    issueKey: 'ISS-11',
    status: 'in_progress',
    reopenCount: 0,
    updatedAt: T2,
    linkedAt: T2,
    closedAt: null,
    targets: [],
    observedSteps: ['o-extra'],
    release: null,
    failing: [],
    judgedAgainst: [],
    run: null,
    ...over,
  });

  it('reads a Not in design node decided delete as cleaning while its build naming the observed step is open', () => {
    const h = deriveHealth(
      facts({ observation: obsOf(extra, T0), decisions: [deleteIt(T1)], builds: [build()] }),
    );
    expect(node(h, 'observed:o-extra')?.phase).toBe('cleaning');
    expect(h.reconciliation.state).toBe('open');
    expect(h.reconciliation.cleaning).toBe(1);
  });

  it('never counts a build naming only planned steps toward an observed node', () => {
    const h = deriveHealth(
      facts({
        observation: obsOf(extra, T0),
        decisions: [deleteIt(T1)],
        builds: [build({ observedSteps: [], targets: [{ kind: 'step', step: 'o-extra' }] })],
      }),
    );
    expect(node(h, 'observed:o-extra')?.phase).toBe('decided');
  });

  it('stays decided against a newer observation while no build was linked after the decision', () => {
    const h = deriveHealth(facts({ observation: obsOf(extra, NOW), decisions: [deleteIt(T1)] }));
    expect(node(h, 'observed:o-extra')?.phase).toBe('decided');
    expect(h.reconciliation.state).toBe('open');
  });

  it('reads the design reconciled, naming the version and the proven criteria, once the released build is observed gone', () => {
    const shipped = build({
      status: 'closed',
      closedAt: T2,
      release: { version: '0.4.0-dev.31', releasedAt: T2 },
    });
    const criterion = (code: string, proof: 'pass' | 'fail' | null) => ({
      requirementKey: 'REQ-18',
      code,
      sinceRevision: 1,
      sinceAcceptedAt: T0,
      targets: [{ kind: 'step' as const, step: 'check' }],
      proof,
    });
    const h = deriveHealth(
      facts({
        observation: obsOf(fullMatch, NOW),
        decisions: [deleteIt(T1)],
        builds: [shipped],
        criteria: [criterion('BC-1', 'pass'), criterion('BC-2', 'fail')],
      }),
    );
    expect(node(h, 'observed:o-extra')).toBeUndefined();
    expect(h.reconciliation).toMatchObject({
      state: 'reconciled',
      undecided: 0,
      cleaning: 0,
      issues: ['ISS-11'],
      version: { version: '0.4.0-dev.31' },
      criteria: { total: 2, proven: 1 },
    });
  });

  it('stays open while the closed build is in no released version', () => {
    const h = deriveHealth(
      facts({
        observation: obsOf(fullMatch, NOW),
        decisions: [deleteIt(T1)],
        builds: [build({ status: 'closed', closedAt: T2 })],
      }),
    );
    expect(h.reconciliation.state).toBe('open');
    expect(h.reconciliation.version).toBeNull();
    expect(h.reconciliation.rule).toContain('ISS-11');
  });

  it('stays open while a marked node waits on a decision, and while the code was never observed', () => {
    const marked = deriveHealth(facts({ observation: obsOf(extra, T0) }));
    expect(marked.reconciliation.state).toBe('open');
    expect(marked.reconciliation.undecided).toBeGreaterThan(0);
    expect(deriveHealth(facts()).reconciliation.state).toBe('open');
  });
});
