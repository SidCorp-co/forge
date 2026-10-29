/**
 * A `needs_info` park changes what kind of wait it is without leaving `needs_info` (ISS-631, FB-264,
 * REQ-2 BC-7 and BC-9). The re-kind is the transition door at the park: `toStatus: needs_info` with a
 * `waitingKind` other than the park's own. It withdraws what the park asked, records the new kind, and
 * asks the new question; the standing and the park view then read the new wait, never an answer given
 * before it. The same kind again is still `NO_OP`; a wrong kind, `about` or missing reason is refused
 * by name and writes nothing, and so is a merge mark other than the parked issue's own, which is
 * ordering between issues and a `blocks` edge (ISS-738).
 */

// @direct-test-of packages/core/src/issues/park-question.ts
// @direct-test-of packages/core/src/issues/park-repoint.ts
// @direct-test-of packages/core/src/issues/park-since.ts
// @direct-test-of packages/core/src/issues/park-view.ts
// @direct-test-of packages/core/src/issues/standing-read.ts
// @direct-test-of packages/core/src/questions/issue-coupling.ts
// @direct-test-of packages/core/src/questions/merge-wait.ts
// @direct-test-of packages/core/src/questions/write.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  refusalCodes,
  requester,
  settleOutbox,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';

let w: EcosystemWorld;
let projectId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  projectId = w.project.forge;
  ownerId = w.user.platform;
  const { mintPat } = await import('../../src/credentials/pat.js');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(w.app, {
    owner: w.token.platform,
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

let seq = 6310;
/** An issue planted at `in_progress`, the status its park returns to. */
async function plantIssue(): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${seq}`}, 'in_progress', ${ownerId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

const transition = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, { toStatus: 'needs_info', ...body });

/** The FB-264 park: a decision asked, with what would settle it. */
const parkOnDecision = (issueId: string) =>
  transition(issueId, {
    reason: 'Which GitLab group does the mirror read from?',
    waitingKind: 'needs_decision',
    needs: 'the group, and who decided',
  });

/** The FB-264 re-kind: the decision is settled and the park now waits on a resource. */
const rekindToResource = (issueId: string, body: Doc = {}) =>
  transition(issueId, {
    reason: 'The group is decided; the mirror now needs read access to it.',
    waitingKind: 'needs_resource',
    needs: 'a GitLab read token for the group',
    ...body,
  });

type Asked = {
  id: string;
  status: string;
  prompt: string | null;
  awaits_merge_issue_id: string | null;
};
const questionsOn = (issueId: string) =>
  rows<Asked>(sql`
    SELECT id, status, steps -> 0 ->> 'prompt' AS prompt, awaits_merge_issue_id
      FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const openOn = async (issueId: string) =>
  (await questionsOn(issueId)).filter((q) => q.status === 'open');

async function issueOf(issueId: string): Promise<{ status: string; waitingKind: string | null }> {
  const got = ok(await say('owner', 'GET', `/api/issues/${issueId}`));
  return { status: got.status as string, waitingKind: (got.waitingKind as string | null) ?? null };
}

const parkOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}/park`)).park as Doc;

/** What the issue list reads the issue as waiting on: its act's key and its whole wait. */
async function standingOf(key: string): Promise<{ act: string; waitingOn: Doc }> {
  const row = ok(await say('owner', 'GET', `/api/projects/${projectId}/issues/standing/${key}`));
  const standing = (row.standing ?? row) as Doc;
  const waitingOn = standing.waitingOn as Doc;
  return { act: ((waitingOn.says as Doc).act as Doc).key as string, waitingOn };
}

/** Answer the park's decision, saying it still waits: the answer does not move it (ISS-257). */
async function answerDecision(issueId: string): Promise<string> {
  const [asked] = await openOn(issueId);
  expect(asked, 'the park asked no question').toBeDefined();
  ok(
    await say('owner', 'POST', `/api/questions/${asked?.id}/answer`, {
      round: 1,
      text: 'Read from the platform group.',
      stillWaits: { reason: 'read access to the platform group' },
    }),
  );
  await settleOutbox();
  return asked?.id as string;
}

describe('a needs_info park changes its waiting kind without leaving needs_info', () => {
  it('re-kinds an answered decision park to a resource park, and every reader reads the resource (FB-264)', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    const decision = await answerDecision(issue.id);
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_decision',
    });

    // before: the answered decision is what the park reads as
    const before = await parkOf(issue.id);
    expect(before.owes).toBe('decision');
    expect((before.answered as Doc | null)?.questionId).toBe(decision);
    expect((await standingOf(issue.key)).act).toBe('issues.standing.act.resumeOnce');

    const res = await rekindToResource(issue.id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ status: 'needs_info' });
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_resource',
    });

    // after: the resource, and nothing of the answered decision
    const open = await openOn(issue.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.prompt).toContain('needs read access');
    expect((res.json.repointed as Doc).asked).toEqual([open[0]?.id]);
    const after = await parkOf(issue.id);
    expect(after.owes).toBe('resource');
    expect(after.answered).toBeNull();
    expect(after.openQuestionIds).toEqual([open[0]?.id]);
    expect((after.record as Doc).kind).toBe('needs_resource');
    expect((after.resume as Doc).at).toBe('in_progress');
    const standing = await standingOf(issue.key);
    expect(standing.act, JSON.stringify(standing.waitingOn)).toBe('issues.standing.act.supply');

    // the thread says what changed, as a notice no run reads as a person's reply
    const notices = (ok(await say('owner', 'GET', `/api/issues/${issue.id}/comments`)).items ??
      []) as Doc[];
    const said = notices.map((c) => c.body as string).find((b) => b.startsWith('↪ **Re-pointed'));
    expect(said).toContain('needs_resource');
    expect(said).toContain('in place of `needs_decision`');
  });

  it('re-kinds back to a decision with a new question, withdrawing the resource question the park asked', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);
    ok(await rekindToResource(issue.id));
    const [resource] = await openOn(issue.id);

    const res = await transition(issue.id, {
      reason: 'The token arrived, and it reads two groups: which one is the mirror?',
      waitingKind: 'needs_decision',
      needs: 'the one group',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const open = await openOn(issue.id);
    expect(open).toHaveLength(1);
    expect(res.json.repointed).toEqual({ withdrawn: [resource?.id], asked: [open[0]?.id] });
    expect(
      (await questionsOn(issue.id)).find((q) => q.id === resource?.id)?.status,
      'the resource question the park no longer waits on',
    ).toBe('void');
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_decision',
    });
    expect((await parkOf(issue.id)).owes).toBe('decision');
    expect((await standingOf(issue.key)).act).toBe('issues.standing.act.decide');
  });

  it('takes a person re-kinding the park, which asks nothing, and the standing reads the new kind', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);
    expect((await standingOf(issue.key)).act).toBe('issues.standing.act.resumeOnce');

    const res = await transition(
      issue.id,
      { reason: 'Decided; it waits on the read token now.', waitingKind: 'needs_resource' },
      'owner',
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await openOn(issue.id)).toEqual([]);
    expect((await issueOf(issue.id)).waitingKind).toBe('needs_resource');
    expect((await parkOf(issue.id)).answered).toBeNull();
    expect((await standingOf(issue.key)).act).toBe('issues.standing.act.supply');
  });

  it('withdraws a question the park asked that nobody answered yet, naming the new wait', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    const [unanswered] = await openOn(issue.id);

    const res = await rekindToResource(issue.id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((res.json.repointed as Doc).withdrawn).toEqual([unanswered?.id]);
    const all = await questionsOn(issue.id);
    expect(all.find((q) => q.id === unanswered?.id)?.status).toBe('void');
    expect(all.filter((q) => q.status === 'open')).toHaveLength(1);
  });

  it('refuses the kind the park already is as no change, and writes nothing', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);
    const before = await questionsOn(issue.id);

    const res = await transition(issue.id, {
      reason: 'still a decision',
      waitingKind: 'needs_decision',
      needs: 'the group',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(refusalCodes(res)).toEqual(['NO_OP']);
    expect(JSON.stringify(res.json)).toContain('already a `needs_decision` park');
    expect(await questionsOn(issue.id)).toEqual(before);
    expect((await issueOf(issue.id)).waitingKind).toBe('needs_decision');
  });

  it('refuses a kind that is none, an `about` of the wrong shape and a re-kind with no reason, by name', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);
    const before = await questionsOn(issue.id);

    const badKind = await rekindToResource(issue.id, { waitingKind: 'needs_coffee' });
    expect(badKind.status).toBe(400);
    expect(JSON.stringify(badKind.json)).toContain('waitingKind');

    const badAbout = await rekindToResource(issue.id, { about: 'REQ-2' });
    expect(badAbout.status).toBe(400);
    expect(refusalCodes(badAbout)).toEqual(['QUESTION_ABOUT_SHAPE']);

    const noReason = await transition(issue.id, {
      waitingKind: 'needs_resource',
      needs: 'a token',
    });
    expect(noReason.status).toBe(422);
    expect(refusalCodes(noReason)).toEqual(['TRANSITION_REASON_REQUIRED']);

    expect(await questionsOn(issue.id)).toEqual(before);
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_decision',
    });
  });
});

describe('a needs_info park re-kinded onto a merge mark waits only on its own (ISS-738)', () => {
  it('re-kinds onto its own merge mark, and the park waits on the mark rather than the answered decision', async () => {
    const issue = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);

    const res = await rekindToResource(issue.id, {
      needs: undefined,
      awaitsMerge: { issueId: issue.id },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const open = await openOn(issue.id);
    expect(open.map((q) => q.awaits_merge_issue_id)).toEqual([issue.id]);
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_resource',
    });
    expect((await parkOf(issue.id)).answered).toBeNull();
    expect((await standingOf(issue.key)).act).toBe('issues.standing.act.supply');
  });

  it("refuses a re-kind onto another issue's merge mark as ordering, naming the blocks edge, and writes nothing (ISS-738)", async () => {
    const issue = await plantIssue();
    const other = await plantIssue();
    ok(await parkOnDecision(issue.id));
    await answerDecision(issue.id);
    const before = await questionsOn(issue.id);
    const parkBefore = await parkOf(issue.id);
    const thread = async () =>
      (
        (ok(await say('owner', 'GET', `/api/issues/${issue.id}/comments`)).items ?? []) as Doc[]
      ).map((c) => c.id);
    const threadBefore = await thread();

    const res = await rekindToResource(issue.id, {
      needs: undefined,
      awaitsMerge: { issueId: other.id },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(refusalCodes(res)).toEqual(['QUESTION_MERGE_IS_ORDERING']);
    const said = JSON.stringify(res.json);
    expect(said).toContain('`blocks` edge');
    expect(said).toContain(`/api/issues/${issue.id}/dependencies`);

    expect(await questionsOn(issue.id)).toEqual(before);
    expect(await issueOf(issue.id)).toEqual({
      status: 'needs_info',
      waitingKind: 'needs_decision',
    });
    expect(await parkOf(issue.id)).toEqual(parkBefore);
    expect(await thread()).toEqual(threadBefore);
  });
});
