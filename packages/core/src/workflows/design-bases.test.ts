// A base refusal carries the facts its detail is worded from, so a client words it in its own
// language; and the designs an approval strands on a stale base are read before the approval.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decisionRefusals } from './design.js';
import { baseApprovalRefusal, designsLeftStale, readBases } from './design-bases.js';

const held = [
  { flow: 'access', designStatus: 'proposed' as const, approvedRevision: 10 },
  { flow: 'consent', designStatus: 'proposed' as const, approvedRevision: null },
  { flow: 'intake', designStatus: 'approved' as const, approvedRevision: 3 },
];

describe('WORKFLOW_DESIGN_BASE_UNAPPROVED carries its facts', () => {
  it('names each refusing base with its state, beside the revision refused', () => {
    const refusal = baseApprovalRefusal(
      7,
      readBases(
        [
          { workflow: 'access', revision: 9 },
          { workflow: 'consent', revision: 1 },
          { workflow: 'gone', revision: 2 },
          { workflow: 'intake', revision: 3 },
        ],
        held,
      ),
    );
    expect(refusal).toMatchObject({ code: 'WORKFLOW_DESIGN_BASE_UNAPPROVED', revision: 7 });
    expect(refusal?.bases).toEqual([
      {
        workflow: 'access',
        revision: 9,
        state: 'stale',
        approvedRevision: 10,
        designStatus: 'proposed',
      },
      {
        workflow: 'consent',
        revision: 1,
        state: 'unapproved',
        approvedRevision: null,
        designStatus: 'proposed',
      },
      {
        workflow: 'gone',
        revision: 2,
        state: 'missing',
        approvedRevision: null,
        designStatus: null,
      },
    ]);
    expect(refusal?.detail).toContain('"access" rev 9');
  });

  it('refuses nothing while every base stands approved at the revision it names', () => {
    expect(baseApprovalRefusal(2, readBases([{ workflow: 'intake', revision: 3 }], held))).toBe(
      null,
    );
  });
});

describe('the designs an approval leaves on a stale base', () => {
  const fixture = readFileSync(
    new URL('../../tests/fixtures/workflows/post-discharge.design.json', import.meta.url),
    'utf8',
  );
  const doc = (flow: string, basedOn?: { workflow: string; revision: number }[]) => ({
    ...JSON.parse(fixture),
    flow,
    ...(basedOn ? { basedOn } : {}),
  });
  const rows = [
    { id: 'w-access', flow: 'access', revision: 11, document: doc('access') },
    {
      id: 'w-case',
      flow: 'operational-case',
      revision: 7,
      document: doc('operational-case', [{ workflow: 'access', revision: 10 }]),
    },
    {
      id: 'w-complaint',
      flow: 'complaint-intake',
      revision: 1,
      document: doc('complaint-intake', [
        { workflow: 'intake', revision: 3 },
        { workflow: 'access', revision: 9 },
      ]),
    },
    {
      id: 'w-ux',
      flow: 'complaint-ux',
      revision: 2,
      document: doc('complaint-ux', [{ workflow: 'access', revision: 11 }]),
    },
    { id: 'w-free', flow: 'free', revision: 4, document: doc('free') },
  ];

  it('lists each design pinning another revision of the approved one, and none pinning it', () => {
    expect(designsLeftStale('access', 11, rows)).toEqual([
      { workflowId: 'w-case', flow: 'operational-case', revision: 7, basedOnRevision: 10 },
      { workflowId: 'w-complaint', flow: 'complaint-intake', revision: 1, basedOnRevision: 9 },
    ]);
  });

  it('lists nothing for a design nobody builds on', () => {
    expect(designsLeftStale('free', 4, rows)).toEqual([]);
  });
});

describe('a decision refusal carries the facts its detail names', () => {
  it('names the status of a design not proposed, and the revision awaiting a decision', () => {
    expect(
      decisionRefusals({
        status: 'approved',
        proposedRevision: null,
        revision: 3,
        decision: 'approve',
        reason: null,
      }),
    ).toEqual([
      expect.objectContaining({ code: 'WORKFLOW_DESIGN_NOT_PROPOSED', status: 'approved' }),
    ]);
    expect(
      decisionRefusals({
        status: 'proposed',
        proposedRevision: 4,
        revision: 3,
        decision: 'approve',
        reason: null,
      }),
    ).toEqual([
      expect.objectContaining({
        code: 'WORKFLOW_DESIGN_REVISION_STALE',
        revision: 3,
        proposedRevision: 4,
      }),
    ]);
  });
});
