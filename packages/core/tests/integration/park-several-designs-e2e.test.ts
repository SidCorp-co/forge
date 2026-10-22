/**
 * An issue that waits on, draws or has approved more than one design (ISS-569, FB-140, FB-141): a
 * park at `needs_info` is re-pointed at a different design rather than refused as no change; a park
 * may wait on several designs and returns only once each is decided; the issue answers every design
 * drawn under it; and each approval joins the mark rather than replacing it or being dropped.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  codesOf,
  decide,
  designIssueWorld,
  gitProject,
  markOf,
  outsideProject,
  plantIssue,
  proposedDesign,
  say,
  writeChanged,
} from '../helpers/design-issue-world.js';
import { type Doc, ok, settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

designIssueWorld();

beforeEach(async () => {
  await settleOutbox();
});

type QuestionRow = {
  id: string;
  status: string;
  awaits_workflow_id: string | null;
  awaits_revision: number | null;
  awaits_merge_issue_id: string | null;
  void_reason: string | null;
  ended_reason: string | null;
};
const questionsOn = (issueId: string) =>
  rows<QuestionRow>(sql`
    SELECT id, status, awaits_workflow_id, awaits_revision, awaits_merge_issue_id, void_reason,
           ended_reason
      FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const open = async (issueId: string) =>
  (await questionsOn(issueId)).filter((q) => q.status === 'open');
const statusOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}`)).status as string;
const transition = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus: 'needs_info',
    reason: 'the build waits on the design approval',
    waitingKind: 'needs_decision',
    ...body,
  });
const repoint = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus: 'needs_info',
    reason: 'the build now waits on the other design',
    ...body,
  });
const movesInto = async (issueId: string) =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'needs_info'`)
  )[0]?.n ?? 0;

describe('a park re-pointed at a different design (criterion 1, FB-141)', () => {
  it('replaces the wait, moves no status, and the new design decides the park', async () => {
    const first = await proposedDesign(gitProject, 'repoint-first-flow');
    const second = await proposedDesign(gitProject, 'repoint-second-flow');
    const issue = await plantIssue(gitProject, 'open');
    ok(await transition(issue.id, { awaitsDesign: { workflowId: first, revision: 1 } }));
    const [parked] = await open(issue.id);
    expect(parked).toMatchObject({ awaits_workflow_id: first });

    const res = await repoint(issue.id, { awaitsDesign: { workflowId: second, revision: 1 } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.status).toBe('needs_info');
    expect(res.json.repointed.withdrawn).toEqual([parked?.id]);
    expect(res.json.repointed.asked).toHaveLength(1);
    expect(await movesInto(issue.id)).toBe(1);

    const all = await questionsOn(issue.id);
    expect(all.find((q) => q.id === parked?.id)).toMatchObject({
      status: 'void',
      ended_reason: 'park_repointed',
    });
    expect(all.find((q) => q.id === parked?.id)?.void_reason).toContain(
      'design `repoint-second-flow` revision 1',
    );
    expect(await open(issue.id)).toEqual([
      expect.objectContaining({ awaits_workflow_id: second, awaits_revision: 1 }),
    ]);
    const notices = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id} ORDER BY created_at`,
    );
    const said = notices.map((c) => c.body).find((b) => b.startsWith('↪ **Re-pointed'));
    expect(said).toContain('in place of a decision on design `repoint-first-flow` revision 1');

    // the design the park no longer waits on is decided: nothing moves
    ok(await decide(gitProject, first, 1, 'approve'));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    ok(await decide(gitProject, second, 1, 'approve'));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('open');
  });

  it('refuses the wait it already holds as no change, and writes nothing', async () => {
    const flow = await proposedDesign(gitProject, 'repoint-same-flow');
    const issue = await plantIssue(gitProject, 'open');
    ok(await transition(issue.id, { awaitsDesign: { workflowId: flow, revision: 1 } }));
    const before = await questionsOn(issue.id);
    const res = await repoint(issue.id, { awaitsDesign: [{ workflowId: flow, revision: 1 }] });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['NO_OP']);
    expect(JSON.stringify(res.json)).toContain(
      'already waits on exactly a decision on design `repoint-same-flow` revision 1',
    );
    expect(await questionsOn(issue.id)).toEqual(before);

    // a call at the park naming no wait is the no-change it always was
    const bare = await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'needs_info',
      reason: 'still waiting',
      waitingKind: 'needs_decision',
    });
    expect(codesOf(bare)).toEqual(['NO_OP']);
    expect(await questionsOn(issue.id)).toEqual(before);
  });

  it('refuses a re-point by a person, with no reason, or changing the kind of park, by name', async () => {
    const first = await proposedDesign(gitProject, 'repoint-refused-first-flow');
    const second = await proposedDesign(gitProject, 'repoint-refused-second-flow');
    const issue = await plantIssue(gitProject, 'open');
    ok(await transition(issue.id, { awaitsDesign: { workflowId: first, revision: 1 } }));
    const before = await questionsOn(issue.id);
    const awaitsDesign = { workflowId: second, revision: 1 };

    const byPerson = await repoint(issue.id, { awaitsDesign }, 'owner');
    expect(codesOf(byPerson)).toEqual(['NEEDS_NOT_APPLICABLE']);
    const noReason = await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'needs_info',
      awaitsDesign,
    });
    expect(codesOf(noReason)).toEqual(['TRANSITION_REASON_REQUIRED']);
    const kind = await repoint(issue.id, { awaitsDesign, waitingKind: 'needs_resource' });
    expect(codesOf(kind)).toEqual(['WAITING_KIND_NOT_APPLICABLE']);
    expect(JSON.stringify(kind.json)).toContain('keeps what kind of park it is');
    const decided = await proposedDesign(gitProject, 'repoint-decided-flow');
    ok(await decide(gitProject, decided, 1, 'approve'));
    const notAwaiting = await repoint(issue.id, {
      awaitsDesign: { workflowId: decided, revision: 1 },
    });
    expect(codesOf(notAwaiting)).toEqual(['QUESTION_DESIGN_NOT_AWAITING']);

    expect(await questionsOn(issue.id)).toEqual(before);
    expect(await statusOf(issue.id)).toBe('needs_info');
  });

  it('withdraws a re-pointed wait when the park is left another way', async () => {
    const first = await proposedDesign(gitProject, 'repoint-left-first-flow');
    const second = await proposedDesign(gitProject, 'repoint-left-second-flow');
    const issue = await plantIssue(gitProject, 'open');
    ok(await transition(issue.id, { awaitsDesign: { workflowId: first, revision: 1 } }));
    ok(await repoint(issue.id, { awaitsDesign: { workflowId: second, revision: 1 } }));
    ok(
      await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
        toStatus: 'open',
        reason: 'the run carries on without the design',
      }),
    );
    expect(await open(issue.id)).toEqual([]);
  });
});

describe('an issue waiting on, drawing or approved for several designs (criterion 2, FB-140)', () => {
  it('a park on two designs stays parked after the first decision and returns after the second', async () => {
    const a = await proposedDesign(gitProject, 'several-wait-a-flow');
    const b = await proposedDesign(gitProject, 'several-wait-b-flow');
    const issue = await plantIssue(gitProject, 'open');
    const res = await transition(issue.id, {
      awaitsDesign: [
        { workflowId: a, revision: 1 },
        { workflowId: b, revision: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await open(issue.id)).map((q) => q.awaits_workflow_id).sort()).toEqual([a, b].sort());
    const park = ok(await say('owner', 'GET', `/api/issues/${issue.id}/park`)).park;
    expect(park.openQuestionIds).toHaveLength(2);

    ok(await decide(gitProject, a, 1, 'approve'));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    ok(await decide(gitProject, b, 1, 'return', 'name the consent owner'));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('open');
  });

  it('refuses a design named twice in one park, by its place in the list, writing nothing', async () => {
    const a = await proposedDesign(gitProject, 'several-twice-flow');
    const issue = await plantIssue(gitProject, 'open');
    const res = await transition(issue.id, {
      awaitsDesign: [
        { workflowId: a, revision: 1 },
        { workflowId: a, revision: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('/awaitsDesign/1');
    expect(JSON.stringify(res.json)).toContain('is named twice');
    expect(await statusOf(issue.id)).toBe('open');
    expect(await questionsOn(issue.id)).toEqual([]);
  });

  // K36 on dev.273: 21 designs answered `400 at /awaitsDesign: Invalid input`, the union hiding the cap
  it('refuses a list of more than 20 designs, or none, naming the cap at /awaitsDesign, writing nothing', async () => {
    const issue = await plantIssue(gitProject, 'open');
    const many = Array.from({ length: 21 }, (_, i) => ({
      workflowId: randomUUID(),
      revision: i + 1,
    }));
    const cases: Array<[Doc[], string]> = [
      [many, 'names 21 designs; a park waits on at most 20'],
      [[], 'names no design; a park waits on at least one'],
    ];
    for (const [awaitsDesign, said] of cases) {
      const res = await transition(issue.id, { awaitsDesign });
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      const rows = (res.json.error?.refusals ?? []) as Doc[];
      expect(rows).toEqual([
        expect.objectContaining({ code: 'BAD_REQUEST', path: '/awaitsDesign' }),
      ]);
      expect(rows[0]?.detail).toContain(said);
      expect(rows[0]?.detail).toContain('a list of 1 to 20');
      expect(res.json.detail).not.toBe('Invalid input');
    }
    // a list whose own item is the wrong type, which aborts the list's branch of the union
    const wrongType = await transition(issue.id, {
      awaitsDesign: [{ workflowId: randomUUID(), revision: 'one' }],
    });
    expect(wrongType.status, JSON.stringify(wrongType.json)).toBe(400);
    expect(wrongType.json.error?.refusals).toEqual([
      expect.objectContaining({
        path: '/awaitsDesign/0/revision',
        detail: expect.stringContaining('expected number'),
      }),
    ]);
    expect(await statusOf(issue.id)).toBe('open');
    expect(await questionsOn(issue.id)).toEqual([]);
  });

  it('answers every design drawn under the issue, each at the latest revision drawn there', async () => {
    const issue = await plantIssue(gitProject, 'in_progress');
    const a = await proposedDesign(gitProject, 'several-drawn-a-flow', issue.id);
    const b = await proposedDesign(gitProject, 'several-drawn-b-flow', issue.id);
    ok(await decide(gitProject, a, 1, 'approve'));
    ok(await writeChanged(gitProject, a, issue.key));
    const read = ok(await say('owner', 'GET', `/api/issues/${issue.id}`));
    expect(read.proposesWorkflow).toBeUndefined();
    expect(read.proposesWorkflows).toHaveLength(2);
    expect(read.proposesWorkflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflowId: a, revision: 2, decision: null }),
        expect.objectContaining({ workflowId: b, revision: 1, decision: null }),
      ]),
    );
    const none = await plantIssue(gitProject, 'open');
    expect(ok(await say('owner', 'GET', `/api/issues/${none.id}`)).proposesWorkflows).toEqual([]);
  });

  // K36 on dev.273: ISS-498's rail read "r21 · Approved" although r21 was returned under it and a
  // later revision drawn elsewhere was approved; each entry carries its own revision's state
  it("answers the state of the revision drawn under the issue, not the flow's head status", async () => {
    const issue = await plantIssue(gitProject, 'in_progress');
    const elsewhere = await plantIssue(gitProject, 'in_progress');
    const a = await proposedDesign(gitProject, 'several-state-a-flow', issue.id);
    const b = await proposedDesign(gitProject, 'several-state-b-flow', issue.id);
    const c = await proposedDesign(gitProject, 'several-state-c-flow', issue.id);
    ok(await decide(gitProject, a, 1, 'return', 'the SLA is 48h'));
    ok(await writeChanged(gitProject, a, elsewhere.key));
    ok(await decide(gitProject, a, 2, 'approve'));
    ok(await decide(gitProject, b, 1, 'approve'));
    const entries = ok(await say('owner', 'GET', `/api/issues/${issue.id}`))
      .proposesWorkflows as Doc[];
    const of = (id: string) => entries.find((e) => e.workflowId === id);
    expect(of(a)).toEqual(
      expect.objectContaining({
        revision: 1,
        decision: 'return',
        designStatus: 'approved',
        state: 'returned',
      }),
    );
    expect(of(b)).toEqual(
      expect.objectContaining({ revision: 1, decision: 'approve', state: 'current' }),
    );
    expect(of(c)).toEqual(
      expect.objectContaining({ revision: 1, decision: null, state: 'proposed' }),
    );
  });

  it('keeps each approved design on a git mark, the later revision of a design in place of its earlier', async () => {
    const issue = await plantIssue(gitProject, 'in_progress');
    const a = await proposedDesign(gitProject, 'several-git-a-flow', issue.id);
    const b = await proposedDesign(gitProject, 'several-git-b-flow', issue.id);
    expect(ok(await decide(gitProject, a, 1, 'approve')).designIssue).toMatchObject({
      action: 'marked',
    });
    const stampedAt = (await markOf(issue.id))?.merged_at?.getTime();
    expect(ok(await decide(gitProject, b, 1, 'approve')).designIssue).toMatchObject({
      action: 'added',
      mark: 'asserted',
    });
    let row = await markOf(issue.id);
    expect(row?.merged_artifacts).toEqual([
      { surface: 'design', ref: 'several-git-a-flow@rev1', change: 'changed' },
      { surface: 'design', ref: 'several-git-b-flow@rev1', change: 'changed' },
    ]);
    expect(row?.merged_at?.getTime()).toBe(stampedAt);
    const notice = (
      await rows<{ body: string }>(sql`SELECT body FROM comments WHERE issue_id = ${issue.id}`)
    )
      .map((c) => c.body)
      .find((body) => body.includes('`several-git-b-flow` revision 1 was approved'));
    expect(notice).toContain('beside several-git-a-flow@rev1');

    ok(await writeChanged(gitProject, a, issue.key));
    ok(await decide(gitProject, a, 2, 'approve'));
    row = await markOf(issue.id);
    expect(row?.merged_artifacts).toEqual([
      { surface: 'design', ref: 'several-git-b-flow@rev1', change: 'changed' },
      { surface: 'design', ref: 'several-git-a-flow@rev2', change: 'changed' },
    ]);
  });

  it('names each approved design on a landing outside git', async () => {
    const issue = await plantIssue(outsideProject, 'in_progress');
    const a = await proposedDesign(outsideProject, 'several-out-a-flow', issue.id);
    const b = await proposedDesign(outsideProject, 'several-out-b-flow', issue.id);
    ok(await decide(outsideProject, a, 1, 'approve'));
    expect(ok(await decide(outsideProject, b, 1, 'approve')).designIssue).toMatchObject({
      action: 'added',
      mark: 'landed',
    });
    const row = await markOf(issue.id);
    expect(row?.merged_landing).toBe(
      'workflow designs `several-out-a-flow` revision 1, `several-out-b-flow` revision 1, approved',
    );
    expect(row?.merged_artifacts).toEqual([
      { surface: 'design', ref: 'several-out-a-flow@rev1', change: 'changed' },
      { surface: 'design', ref: 'several-out-b-flow@rev1', change: 'changed' },
    ]);
  });
});
