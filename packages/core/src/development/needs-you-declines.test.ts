// ISS-539 (REQ-7 c2, K31 on 0.4.0-dev.269): which answer of a decision says no is core's to say, so
// the Approvals page's ✕ presses that answer and no other. Each builder marks exactly the act that
// returns, rejects, drops, defers or reopens; an act that approves, answers or re-pins never declines,
// and a kind with no such act has no declining answer at all.

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import type { AttentionRow } from './needs-you.js';
import { acceptDecision, admitDecision, repinDecision } from './needs-you-accept-builders.js';
import {
  agreeDecision,
  designDecision,
  releaseDecision,
  revisionDecision,
} from './needs-you-approve-builders.js';
import type { Built } from './needs-you-decision-builders.js';
import { feedbackDecision } from './needs-you-decision-builders.js';

const P = '6f0ee160-8432-4b84-98cf-956b6cd65a29';
const row = (entity: AttentionRow['entity'], key: string): AttentionRow =>
  ({ entity, key, title: key, touchedAt: '2026-10-21T09:00:00.000Z' }) as unknown as AttentionRow;

/** The decision as the read serves it, parsed by the contract, and the ids of its declining answers. */
function declining(b: Built): string[] {
  const d = needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'requirement',
    proposal: null,
    ...b.decision,
  });
  return d.answers.filter((a) => a.declines).map((a) => `${a.act}:${a.id}`);
}

describe('the answer that says no', () => {
  it('is the return, drop, defer or reopen, each asking why', () => {
    expect(declining(revisionDecision(row('requirement', 'REQ-1'), 'requirements', P, 2))).toEqual([
      'revision.return:return',
    ]);
    expect(declining(agreeDecision(row('requirement', 'REQ-1'), 'requirements', P, 2))).toEqual([
      'requirement.drop:drop',
    ]);
    expect(
      declining(
        acceptDecision(row('requirement', 'REQ-1'), 'requirements', P, 2, { passing: 1, total: 2 }),
      ),
    ).toEqual(['requirement.defer:defer']);
    expect(
      declining(feedbackDecision(row('feedback', 'FB-1'), 'feedback', P, null, 'fix')),
    ).toEqual(['feedback.reopen:reopen']);
    expect(
      declining(
        designDecision(row('workflow', 'flow'), 'designs', P, {
          workflowId: 'wf',
          revision: 3,
          title: 'Order flow',
        }),
      ),
    ).toEqual(['design.decide:return']);
  });

  it("is a release's return, never its approve, though both take words", () => {
    const b = releaseDecision(
      row('release', '0.4.0-dev.270'),
      'releases',
      P,
      { runId: 'run-7', failing: 0, total: 4 },
      'ap-7',
    );
    expect(declining(b)).toEqual(['release.decide:return']);
    const approve = b.decision.answers.find((a) => a.id === 'approve');
    expect(approve).toMatchObject({
      body: { decision: 'approve' },
      needsReason: true,
      declines: false,
    });
  });

  it('is absent where the kind has no act that says no: a take-on and a re-pin', () => {
    expect(
      declining(
        admitDecision(row('requirement', 'REQ-50'), 'requirements', [{ id: 'i', key: 'ISS-601' }]),
      ),
    ).toEqual([]);
    expect(declining(repinDecision(row('requirement', 'REQ-50'), 'requirements', P, 4))).toEqual(
      [],
    );
  });
});
