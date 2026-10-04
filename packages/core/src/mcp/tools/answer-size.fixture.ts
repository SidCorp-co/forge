import { formatIssueRef } from '../../lib/issue-ref.js';

const words = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}-${i}`)
    .join(' ')
    .slice(0, n * 6);

const PROJECT = '11111111-1111-4111-8111-111111111111';
export const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ISSUE = '44444444-4444-4444-8444-444444444444';

export function dischargeDocument() {
  const steps = Array.from({ length: 15 }, (_, i) => ({
    id: `step-${i + 1}`,
    does: words(220, `does${i}`),
    node: {
      type: 'TASK',
      label: `Step ${i + 1}`,
      band: 'care',
      purpose: words(60, `purpose${i}`),
      inputs: ['patient.discharged', 'case.opened'],
      outputs: ['task.assigned'],
      owner: 'care-team',
      sla: '24h',
      conditions: [{ when: words(20, `when${i}`), result: words(20, `then${i}`) }],
    },
    after: i === 0 ? [] : [`step-${i}`],
  }));
  const edges = Array.from({ length: 20 }, (_, i) => ({
    from: `step-${(i % 15) + 1}`,
    to: `step-${((i + 1) % 15) + 1}`,
    kind: 'feeds-back',
    contract: words(100, `edge${i}`),
  }));
  return {
    $schema: 'https://forge.sidcorp.co/schemas/workflow-v2.json',
    version: 2,
    flow: 'discharge-post-care',
    kind: 'flow',
    title: 'Discharge to post-discharge care',
    project: PROJECT,
    summary: words(80, 'summary'),
    template: { id: 'operational-flow', version: 1 },
    writtenBy: {},
    steps,
    edges,
  };
}

export function dischargeDesign() {
  const document = dischargeDocument();
  return {
    workflowId: WORKFLOW_ID,
    flow: 'discharge-post-care',
    status: 'approved' as const,
    revision: 6,
    proposedRevision: null,
    approvedRevision: 6,
    approver: 'owner' as const,
    canDecide: false,
    waitingOn: {
      kind: 'none' as const,
      who: 'Nobody',
      act: '',
      rule: 'revision 6 is approved; work that builds it may start',
    },
    revisions: [6, 5, 4, 3, 2].map((revision) => ({
      revision,
      designIssueId: ISSUE,
      document,
      proposedBy: USER,
      proposedByName: 'Master',
      proposedAt: '2026-10-04T00:00:00.000Z',
      decision: 'approve',
      decidedBy: USER,
      decidedByName: 'Owner',
      decidedAt: '2026-10-04T01:00:00.000Z',
      reason: words(20, `reason${revision}`),
      state: revision === 6 ? ('current' as const) : ('superseded' as const),
    })),
    builds: Array.from({ length: 6 }, (_, i) => ({
      issueId: ISSUE,
      displayId: formatIssueRef('ISS', 100 + i),
      title: `Build discharge step ${i}`,
      status: 'open',
    })),
    gate: { open: true, rule: 'issues that build it may be dispatched: revision 6 is approved' },
    requirements: [{ key: 'REQ-12', title: words(8, 'req'), status: 'agreed', pinnedRevision: 6 }],
  };
}

export function workflowRow() {
  const document = dischargeDocument();
  return {
    revision: 6,
    writer: USER,
    writerName: 'Master',
    design: { status: 'approved' as const, approvedRevision: 6 },
    document: {
      ...document,
      id: WORKFLOW_ID,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    },
  };
}

const criteria = (revision: number) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `c-${revision}-${i}`,
    code: `BC-${i + 1}`,
    body: words(50, `bc${i}`),
    form: 'statement' as const,
    sinceRevision: 1,
    retiredRevision: null,
  }));

function standing() {
  return {
    state: 'in_delivery' as const,
    attentionGroup: 'moving' as const,
    waitingOn: {
      kind: 'issues' as const,
      who: 'Issues',
      act: 'Running 2 of 5',
      rule: 'linked issues are moving',
    },
    facts: {
      passing: 3,
      judged: 4,
      criteria: 12,
      issuesDone: 2,
      issuesRunning: 2,
      issuesTotal: 5,
      proposedRevision: null,
      draftRevision: null,
    },
    shownRevision: 3,
    coverage: criteria(3).map((c) => ({
      code: c.code,
      body: c.body,
      verdict: 'gap' as const,
      issues: [],
    })),
    owner: null,
    touchedAt: '2026-10-04T00:00:00.000Z',
  };
}

function summary(seq: number) {
  return {
    id: `55555555-5555-4555-8555-${String(seq).padStart(12, '0')}`,
    key: `REQ-${seq}`,
    title: `Post-discharge care requirement ${seq}`,
    status: 'agreed' as const,
    currentRevision: 3,
    latestRevision: { revision: 3, state: 'current' as const },
    delivery: {
      phase: 'in_delivery' as const,
      liveIssues: 3,
      startedIssues: 2,
      closedIssues: 2,
      criteriaCoverage: 'unmeasured' as const,
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  };
}

export function requirementList() {
  return Array.from({ length: 28 }, (_, i) => ({ ...summary(i + 1), standing: standing() }));
}

export function requirementDetail() {
  const revisions = [3, 2, 1].map((revision) => ({
    revision,
    state: revision === 3 ? 'current' : 'superseded',
    baseRevision: revision === 1 ? null : revision - 1,
    spec: {
      goal: words(80, 'goal'),
      personas: ['nurse'],
      scopeIn: [words(40, 'in')],
      scopeOut: [],
    },
    tldr: words(60, 'tldr'),
    changeSummary: words(40, 'change'),
    reason: words(40, 'why'),
    authorId: USER,
    authorName: 'Master',
    authorKind: 'agent' as const,
    createdAt: '2026-10-01T00:00:00.000Z',
    proposedAt: '2026-10-02T00:00:00.000Z',
    decidedBy: USER,
    decidedByName: 'Owner',
    decidedAt: '2026-10-03T00:00:00.000Z',
    returnReason: null,
    criteria: criteria(revision),
  }));
  return {
    ...summary(1),
    revisions,
    criteria: criteria(3),
    workflows: [
      {
        workflowId: WORKFLOW_ID,
        flow: 'discharge-post-care',
        title: 'Discharge to post-discharge care',
        designStatus: 'approved' as const,
        approvedRevision: 6,
      },
    ],
    baselines: [
      {
        revision: 3,
        agreedBy: USER,
        agreedByName: 'Owner',
        agreedAt: '2026-10-03T00:00:00.000Z',
        reason: null,
        pins: [],
      },
    ],
    issues: Array.from({ length: 5 }, (_, i) => ({
      issueId: ISSUE,
      displayId: formatIssueRef('ISS', 200 + i),
      title: `Deliver post-discharge piece ${i}`,
      status: 'open',
      plannedRevision: 3,
      changedSincePlan: false,
    })),
    canSignOff: false,
    standing: standing(),
    history: Array.from({ length: 40 }, (_, i) => ({
      id: `h-${i}`,
      at: '2026-10-03T00:00:00.000Z',
      source: 'agent' as const,
      who: 'Master',
      kind: 'Revision',
      text: words(60, `history${i}`),
      issue: null,
      move: null,
    })),
  };
}

export function suggestionList() {
  return Array.from({ length: 18 }, (_, i) => ({
    id: `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`,
    kind: 'breakdown' as const,
    status: 'accepted' as const,
    target: { type: 'requirement' as const, id: '55555555-5555-4555-8555-000000000001' },
    baseRevision: 3,
    payload: { issues: [{ title: 'piece', description: words(800, `payload${i}`) }] },
    payloadVersion: 1,
    fingerprint: 'f'.repeat(32),
    revises: null,
    producerKind: 'agent' as const,
    producerId: USER,
    conversationMessageId: null,
    model: null,
    decidedBy: USER,
    decidedAt: '2026-10-03T00:00:00.000Z',
    reason: words(160, `decision${i}`),
    createdAt: '2026-10-02T00:00:00.000Z',
    payloadPurgedAt: null,
  }));
}
