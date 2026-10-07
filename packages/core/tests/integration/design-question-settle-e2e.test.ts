/**
 * A park that waits on a workflow design revision (ISS-254): the approver's decision answers its
 * question and the issue moves on as an answer moves it; a revision no decision is owed on is refused;
 * a superseded revision is asked again; a parked design issue is not reopened by a return.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const design = (): Doc =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;
const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

let seq = 100;
/** An issue planted at a status under the kernel's flag. */
async function plantIssue(status: string, mergedAt: Date | null = null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId},
              ${mergedAt?.toISOString() ?? null}::timestamptz)
    `),
  );
  return id;
}

async function proposedDesign(flow: string, issue?: string): Promise<string> {
  const d = design();
  d.project = projectId;
  d.flow = flow;
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: d }),
    201,
  );
  const id = made.document.id as string;
  ok(
    await say('master', 'POST', at(`/workflows/${id}/design/propose`), {
      revision: 1,
      ...(issue ? { issue } : {}),
    }),
  );
  return id;
}

type QuestionRow = {
  id: string;
  status: string;
  awaits_workflow_id: string | null;
  awaits_revision: number | null;
  void_reason: string | null;
  answer: string | null;
  answered_by: string | null;
};
const questionsOn = (issueId: string) =>
  rows<QuestionRow>(sql`
    SELECT id, status, awaits_workflow_id, awaits_revision, void_reason,
           steps -> -1 ->> 'answerText' AS answer, steps -> -1 ->> 'answeredBy' AS answered_by
      FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const statusOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}`)).status as string;
const park = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus: 'needs_info',
    reason: 'the build waits on the design approval',
    waitingKind: 'needs_decision',
    ...body,
  });
const decide = (workflowId: string, revision: number, decision: string, reason?: string) =>
  say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
    revision,
    decision,
    ...(reason ? { reason } : {}),
  });

describe('the decision on the revision a park waits on answers its question', () => {
  it('mints a question naming the revision, and the approval answers it and resumes the issue', async () => {
    const workflowId = await proposedDesign('awaited-approve-flow');
    const issue = await plantIssue('open');
    ok(await park(issue, { awaitsDesign: { workflowId, revision: 1 } }));
    const [asked] = await questionsOn(issue);
    expect(asked).toMatchObject({
      status: 'open',
      awaits_workflow_id: workflowId,
      awaits_revision: 1,
    });
    expect(ok(await say('owner', 'GET', `/api/questions/${asked?.id}`))).toMatchObject({
      awaitsWorkflowId: workflowId,
      awaitsRevision: 1,
    });

    ok(await decide(workflowId, 1, 'approve', 'Approved; the SLA step is owed next.'));
    const [settled] = await questionsOn(issue);
    expect(settled).toMatchObject({ status: 'answered', answered_by: ownerId });
    expect(settled?.answer).toContain('`awaited-approve-flow` revision 1 was approved');
    expect(settled?.answer).toContain('the SLA step is owed next');
    await settleOutbox();
    expect(await statusOf(issue)).toBe('open');
  });

  it('answers the question with the return reason, and resumes the issue', async () => {
    const workflowId = await proposedDesign('awaited-return-flow');
    const issue = await plantIssue('open');
    ok(await park(issue, { awaitsDesign: { workflowId, revision: 1 } }));
    ok(await decide(workflowId, 1, 'return', 'name the consent owner'));
    const [settled] = await questionsOn(issue);
    expect(settled).toMatchObject({ status: 'answered', answered_by: ownerId });
    expect(settled?.answer).toContain('was returned by its approver: name the consent owner');
    await settleOutbox();
    expect(await statusOf(issue)).toBe('open');
  });
});

describe('a park may wait only on the revision awaiting its approver', () => {
  it('refuses a revision the project never proposed, writing nothing', async () => {
    const workflowId = await proposedDesign('unknown-revision-flow');
    const issue = await plantIssue('open');
    for (const awaitsDesign of [
      { workflowId, revision: 7 },
      { workflowId: randomUUID(), revision: 1 },
    ]) {
      const res = await park(issue, { awaitsDesign });
      expect(res.status, JSON.stringify(res.json)).toBe(422);
      expect(codesOf(res)).toEqual(['QUESTION_DESIGN_UNKNOWN']);
      expect(JSON.stringify(res.json)).toContain(`revision ${awaitsDesign.revision}`);
    }
    expect(await statusOf(issue)).toBe('open');
    expect(await questionsOn(issue)).toEqual([]);
  });

  it('refuses a revision no decision is still owed on, writing nothing', async () => {
    const workflowId = await proposedDesign('decided-revision-flow');
    ok(await decide(workflowId, 1, 'approve'));
    const issue = await plantIssue('open');
    const res = await park(issue, { awaitsDesign: { workflowId, revision: 1 } });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['QUESTION_DESIGN_NOT_AWAITING']);
    expect(JSON.stringify(res.json)).toContain('revision 1 is approved');
    expect(await statusOf(issue)).toBe('open');
    expect(await questionsOn(issue)).toEqual([]);
  });

  it('refuses awaitsDesign on a move that mints no question, and from a person', async () => {
    const workflowId = await proposedDesign('not-a-park-flow');
    const issue = await plantIssue('open');
    const held = await say('master', 'POST', `/api/issues/${issue}/transition`, {
      toStatus: 'on_hold',
      reason: 'paused',
      awaitsDesign: { workflowId, revision: 1 },
    });
    expect(held.status, JSON.stringify(held.json)).toBe(422);
    expect(codesOf(held)).toEqual(['NEEDS_NOT_APPLICABLE']);
    const byPerson = await park(issue, { awaitsDesign: { workflowId, revision: 1 } }, 'owner');
    expect(byPerson.status, JSON.stringify(byPerson.json)).toBe(422);
    expect(codesOf(byPerson)).toEqual(['NEEDS_NOT_APPLICABLE']);
    expect(await statusOf(issue)).toBe('open');
    expect(await questionsOn(issue)).toEqual([]);
  });
});

describe('what else a design write or decision does to a waiting park', () => {
  it('asks again of the revision that superseded the one waited on, and keeps the park', async () => {
    const workflowId = await proposedDesign('superseded-flow');
    const issue = await plantIssue('open');
    ok(await park(issue, { awaitsDesign: { workflowId, revision: 1 } }));
    const d = design();
    d.project = projectId;
    d.flow = 'superseded-flow';
    d.id = workflowId;
    d.steps[0].node.label = 'Hospital HIS (revised)';
    ok(
      await say('master', 'PUT', at(`/workflows/${workflowId}`), { baseRevision: 1, document: d }),
    );

    const [voided, reasked] = await questionsOn(issue);
    expect(voided).toMatchObject({ status: 'void', awaits_revision: 1 });
    expect(voided?.void_reason).toContain('revision 1 was superseded by revision 2');
    expect(reasked).toMatchObject({
      status: 'open',
      awaits_workflow_id: workflowId,
      awaits_revision: 2,
    });
    await settleOutbox();
    expect(await statusOf(issue)).toBe('needs_info');

    ok(await decide(workflowId, 2, 'approve'));
    await settleOutbox();
    expect(await statusOf(issue)).toBe('open');
  });

  it('leaves other questions alone, and an issue still holding one stays parked', async () => {
    const workflowId = await proposedDesign('left-alone-flow');
    const other = await proposedDesign('left-alone-other-flow');
    const elsewhere = await plantIssue('open');
    ok(await park(elsewhere, { awaitsDesign: { workflowId: other, revision: 1 } }));
    const byHand = await plantIssue('open');
    ok(await park(byHand, { awaitsDesign: { workflowId, revision: 1 } }));
    const [handQuestion] = await questionsOn(byHand);
    ok(
      await say('owner', 'POST', `/api/questions/${handQuestion?.id}/answer`, {
        text: 'go ahead, I approve it in principle',
        round: 1,
      }),
    );
    const holding = await plantIssue('open');
    ok(await park(holding, { awaitsDesign: { workflowId, revision: 1 } }));
    ok(
      await say('master', 'POST', '/api/questions', {
        issueId: holding,
        prompt: 'which tenant is this for?',
        options: [
          {
            id: 'a',
            label: 'tenant A',
            authority: 'writer',
            bindsTo: 'session',
            executedBy: 'agent',
          },
          {
            id: 'b',
            label: 'tenant B',
            authority: 'writer',
            bindsTo: 'session',
            executedBy: 'agent',
          },
        ],
        recommendedOptionId: 'a',
      }),
      201,
    );
    await settleOutbox();

    ok(await decide(workflowId, 1, 'approve'));
    await settleOutbox();
    expect((await questionsOn(elsewhere)).map((q) => q.status)).toEqual(['open']);
    expect(await statusOf(elsewhere)).toBe('needs_info');
    expect((await questionsOn(byHand))[0]?.answer).toBe('go ahead, I approve it in principle');
    const held = await questionsOn(holding);
    expect(held.map((q) => q.status)).toEqual(['answered', 'open']);
    expect(await statusOf(holding)).toBe('needs_info');
  });

  it('on return over a parked design issue, answers 200, posts the reason and makes no move of its own', async () => {
    const unlinked = await plantIssue('open');
    const unlinkedFlow = await proposedDesign('parked-unlinked-flow', `ISS-${seq}`);
    ok(await park(unlinked, { needs: 'which SLA applies?' }));
    const returned = ok(await decide(unlinkedFlow, 1, 'return', 'the SLA is 48h by contract'));
    expect(returned.designIssue).toMatchObject({ issueId: unlinked, action: 'commented' });
    await settleOutbox();
    expect(await statusOf(unlinked)).toBe('needs_info');
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${unlinked}`,
    );
    expect(posted.map((c) => c.body).join('\n')).toContain('the SLA is 48h by contract');

    const linked = await plantIssue('open');
    const linkedFlow = await proposedDesign('parked-linked-flow', `ISS-${seq}`);
    ok(await park(linked, { awaitsDesign: { workflowId: linkedFlow, revision: 1 } }));
    expect(
      ok(await decide(linkedFlow, 1, 'return', 'draw the consent check')).designIssue,
    ).toMatchObject({ issueId: linked, action: 'commented' });
    await settleOutbox();
    expect(await statusOf(linked)).toBe('open');
  });

  it('reads the park inside the decision, and hands back by that reading once the issue has resumed', async () => {
    const { db } = await import('../../src/db/client.js');
    const { parkedAtDecision, handBack } = await import('../../src/workflows/design-issue.js');
    const parked = await plantIssue('open');
    ok(await park(parked, { needs: 'which SLA applies?' }));
    const resumed = await plantIssue('awaiting_release', new Date('2026-10-02T09:19:03Z'));
    expect(await db.transaction((tx) => parkedAtDecision(tx, parked))).toBe(true);
    expect(await db.transaction((tx) => parkedAtDecision(tx, resumed))).toBe(false);
    expect(await db.transaction((tx) => parkedAtDecision(tx, null))).toBe(false);

    const handed = await handBack({
      projectId,
      flow: 'resumed-before-hand-back-flow',
      revision: 1,
      reason: 'split the two pipelines',
      designIssueId: resumed,
      parked: true,
      decider: { userId: ownerId, agency: 'human' },
    });
    expect(handed).toEqual({ issueId: resumed, action: 'commented', status: 'awaiting_release' });
    expect(await statusOf(resumed)).toBe('awaiting_release');
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${resumed}`,
    );
    expect(posted.map((c) => c.body).join('\n')).toContain('split the two pipelines');
  });
});
