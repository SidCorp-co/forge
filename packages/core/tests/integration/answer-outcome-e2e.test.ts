/**
 * What an answer does to the issue it stopped. An answer may say the issue still waits (ISS-257).
 * Every answer records what it did to its park, and the page names what a park the answer did not
 * move still waits on (ISS-258). An agent's question comment is a Question a person answers
 * (ISS-260).
 */

import { randomUUID } from 'node:crypto';
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
let stagedId: string;
let ownerId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  stagedId = (await createTestProject(ownerId, { policy: null })).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

let seq = 200;
/** An issue planted at a status under the kernel's flag; its key is `ISS-<seq>`. */
async function plantIssue(
  status: string,
  project = projectId,
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${project}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

type Step = { hold?: Doc; resume?: Doc; answeredAt?: string };
const questionsOn = (issueId: string) =>
  rows<{ id: string; status: string; step: Step }>(sql`
    SELECT id, status, steps -> -1 AS step FROM agent_questions
     WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const statusOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}`)).status as string;

/** The master parks an open issue on a question only a person answers; its question's id. */
async function parked(): Promise<{ id: string; key: string; questionId: string }> {
  const issue = await plantIssue('open');
  ok(
    await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'needs_info',
      reason: 'which of the two flows ships first?',
      waitingKind: 'needs_decision',
      needs: 'the owner names the flow that ships first',
    }),
  );
  const [question] = await questionsOn(issue.id);
  if (!question) throw new Error('the park minted no question');
  return { ...issue, questionId: question.id };
}

const answer = (questionId: string, body: Doc = {}) =>
  say('owner', 'POST', `/api/questions/${questionId}/answer`, {
    text: 'the intake flow ships first',
    round: 1,
    ...body,
  });

const deadOrRetrying = async () =>
  (
    await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pgboss_v12.job
       WHERE name = 'outbox.answer-resume' AND state IN ('retry', 'failed')`)
  )[0]?.n ?? 0;

const standingOf = (key: string, project = projectId) =>
  say('owner', 'GET', `/api/projects/${project}/issues/standing/${key}`);

describe('an answer that says the issue still waits (ISS-257)', () => {
  it('keeps the park where it is, the hold on the answered round', async () => {
    const issue = await parked();
    ok(
      await answer(issue.questionId, { stillWaits: { reason: 'both design revisions approved' } }),
    );
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    const [q] = await questionsOn(issue.id);
    expect(q?.status).toBe('answered');
    expect(q?.step.hold).toEqual({ reason: 'both design revisions approved' });
    expect(q?.step.resume).toMatchObject({ kind: 'held' });
    const standing = ok(await standingOf(issue.key));
    expect(standing.blocker.reason).toContain('still waits: both design revisions approved');
    expect(standing.standing.waitingOn.act).toBe('resume once: both design revisions approved');
  });

  it('writes the blocks edge it names, and the park returns to open withheld by it', async () => {
    const blocker = await plantIssue('open');
    const issue = await parked();
    ok(
      await answer(issue.questionId, {
        stillWaits: { reason: 'the intake design lands first', blockedBy: blocker.key },
      }),
    );
    const [edge] = await rows<{ kind: string }>(sql`
      SELECT kind FROM issue_dependencies
       WHERE from_issue_id = ${blocker.id} AND to_issue_id = ${issue.id} AND valid_until IS NULL`);
    expect(edge?.kind).toBe('blocks');
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('open');
    const [q] = await questionsOn(issue.id);
    expect(q?.step.hold).toEqual({
      reason: 'the intake design lands first',
      blockedBy: { id: blocker.id, key: blocker.key },
    });
    expect(q?.step.resume).toMatchObject({ kind: 'resumed', to: 'open' });
    const claim = await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'in_progress',
    });
    expect(codesOf(claim)).toContain('ISSUE_BLOCKED');
  });

  it('refuses a hold it cannot carry by name, and the question stays open', async () => {
    const issue = await parked();
    const cases: Array<[Doc, string]> = [
      [{ reason: '   ' }, 'QUESTION_HOLD_REASON_REQUIRED'],
      [{ reason: 'waits', blockedBy: 'ISS-999999' }, 'QUESTION_HOLD_BLOCKER_UNKNOWN'],
      [{ reason: 'waits', blockedBy: randomUUID() }, 'QUESTION_HOLD_BLOCKER_UNKNOWN'],
      [{ reason: 'waits', blockedBy: issue.key }, 'SELF_DEP'],
    ];
    for (const [stillWaits, code] of cases) {
      const res = await answer(issue.questionId, { stillWaits });
      expect(codesOf(res), JSON.stringify(res.json)).toEqual([code]);
    }
    const elsewhere = await plantIssue('open', stagedId);
    const crossed = await answer(issue.questionId, {
      stillWaits: { reason: 'waits', blockedBy: elsewhere.id },
    });
    expect(codesOf(crossed)).toEqual(['QUESTION_HOLD_BLOCKER_UNKNOWN']);
    const [q] = await questionsOn(issue.id);
    expect(q?.status).toBe('open');
    const edges = await rows(sql`SELECT 1 FROM issue_dependencies WHERE to_issue_id = ${issue.id}`);
    expect(edges).toEqual([]);

    const { askQuestion } = await import('../../src/questions/index.js');
    const loose = await askQuestion({
      id: randomUUID(),
      projectId,
      prompt: 'a decision that stops no issue',
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'a word' },
    });
    const noIssue = await answer(loose.id, { stillWaits: { reason: 'waits' } });
    expect(codesOf(noIssue)).toEqual(['QUESTION_HOLD_NO_ISSUE']);
  });
});

describe('what an answer did to its park is recorded and named (ISS-258)', () => {
  it('records the return to the status the park left', async () => {
    const issue = await parked();
    ok(await answer(issue.questionId));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('open');
    const [q] = await questionsOn(issue.id);
    expect(q?.step.resume).toMatchObject({ kind: 'resumed', to: 'open' });
  });

  it('names a park that recorded no status to return to, instead of an answer owed', async () => {
    const issue = await parked();
    const { db } = await import('../../src/db/client.js');
    await db.execute(
      sql`UPDATE issue_work_state SET left_status = NULL WHERE issue_id = ${issue.id}`,
    );
    ok(await answer(issue.questionId));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    const [q] = await questionsOn(issue.id);
    expect(q?.step.resume).toMatchObject({ kind: 'no_left_status' });

    const { park } = ok(await say('owner', 'GET', `/api/issues/${issue.id}/park`));
    expect(park.answered).toMatchObject({ questionId: issue.questionId });
    expect(park.threadQuestion).toBeNull();
    expect(park.asks).toBe(false);
    const standing = ok(await standingOf(issue.key));
    expect(standing.blocker.reason).toContain('nothing recorded the status this park left');
    expect(standing.blocker.reason).not.toContain('an answer to a question');
    expect(standing.standing.waitingOn.act).toBe('move it on');
  });

  it('records a refused resume by its code, and the delivery completes instead of retrying', async () => {
    const issue = await parked();
    const { db } = await import('../../src/db/client.js');
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${issue.id}`),
    );
    ok(await answer(issue.questionId));
    await settleOutbox();
    const [q] = await questionsOn(issue.id);
    expect(q?.step.resume).toMatchObject({ kind: 'refused', code: 'ISSUE_ARCHIVED' });
    expect(await deadOrRetrying()).toBe(0);
  });

  it('records another open question as what still holds the park', async () => {
    const issue = await parked();
    const second = ok(
      await say('owner', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'and which region first?',
        options: [
          { id: 'eu', label: 'EU', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
          { id: 'us', label: 'US', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
        ],
        recommendedOptionId: 'eu',
      }),
      201,
    );
    ok(await answer(issue.questionId));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    const [first] = await questionsOn(issue.id);
    expect(first?.step.resume).toMatchObject({ kind: 'other_question', questionIds: [second.id] });
  });

  it('records that a staged project moves nothing on an answer, and says so', async () => {
    const issue = await plantIssue('open', stagedId);
    ok(
      await say('owner', 'POST', `/api/issues/${issue.id}/transition`, {
        toStatus: 'needs_info',
        reason: 'which flow first?',
        waitingKind: 'needs_decision',
      }),
    );
    const asked = ok(
      await say('owner', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'which flow first?',
        options: [
          {
            id: 'a',
            label: 'Intake',
            authority: 'writer',
            bindsTo: 'session',
            executedBy: 'agent',
          },
        ],
        recommendedOptionId: 'a',
      }),
      201,
    );
    ok(await answer(asked.id, { text: undefined, optionId: 'a' }));
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('needs_info');
    const [q] = await questionsOn(issue.id);
    expect(q?.step.resume).toMatchObject({ kind: 'staged' });
    const standing = ok(await standingOf(issue.key, stagedId));
    expect(standing.blocker.reason).toContain('not autonomous');
  });
});

describe("an agent's question comment is a Question a person answers (ISS-260)", () => {
  const comment = (who: 'owner' | 'master', issueId: string, body: string) =>
    say(who, 'POST', `/api/issues/${issueId}/comments`, { body, intent: 'question' });

  it('mints a free-text question keyed by the comment, answered through the questions route', async () => {
    const issue = await plantIssue('in_progress');
    const posted = ok(
      await comment(
        'master',
        issue.id,
        'Should the export include archived rows?\nThey are 40% of it.',
      ),
      201,
    );
    const q = ok(await say('owner', 'GET', `/api/questions/${posted.id}`));
    expect(q).toMatchObject({
      status: 'open',
      issueId: issue.id,
      blockerKind: 'human',
      answerShape: 'free_text',
    });
    expect(q.steps[0].prompt).toBe('Should the export include archived rows? They are 40% of it.');
    ok(await answer(posted.id, { text: 'no, live rows only' }));
    const after = ok(await say('owner', 'GET', `/api/questions/${posted.id}`));
    expect(after.status).toBe('answered');
  });

  it('asks once when the comment also carries a question record', async () => {
    const issue = await plantIssue('in_progress');
    const body = [
      'Which reading holds?',
      '',
      '```forge-record',
      'reading: export live rows',
      'reading: export every row',
      '```',
      '',
      '`forge-record: question · contract 1`',
    ].join('\n');
    const posted = ok(await comment('master', issue.id, body), 201);
    const asked = await questionsOn(issue.id);
    expect(asked.map((q) => q.id)).toEqual([posted.id]);
    const q = ok(await say('owner', 'GET', `/api/questions/${posted.id}`));
    expect(q.steps[0].needed).toBe(
      'which reading holds, by number or in your own words: (1) export live rows; (2) export every row',
    );
  });

  it('stores a question comment on finished work as prose, warning by name', async () => {
    const issue = await plantIssue('dropped');
    const posted = ok(await comment('master', issue.id, 'Was this ever needed?'), 201);
    expect(posted.warnings.join(' ')).toContain('QUESTION_ISSUE_TERMINAL');
    expect(await questionsOn(issue.id)).toEqual([]);
  });

  it("keeps a person's question comment owed to an agent, and mints nothing for it", async () => {
    const issue = await plantIssue('in_progress');
    const mine = ok(await comment('owner', issue.id, 'Is the export done?'), 201);
    const theirs = ok(await comment('master', issue.id, 'Which format do you want?'), 201);
    expect((await questionsOn(issue.id)).map((q) => q.id)).toEqual([theirs.id]);
    const { readOwedComments } = await import('../../src/devices/comment-inbox.js');
    const owed = (await readOwedComments(projectId)).items.map((o) => o.commentId);
    expect(owed).toContain(mine.id);
    expect(owed).not.toContain(theirs.id);
  });
});

// hop 2026-10-07: six answers moved their issues back with no comment and no issue event, and the
// pass nudge named none, so a master reported answered questions as owner-pending for passes
describe('an answer leaves its record on the issue it stopped', () => {
  it('writes an answer event naming the question, and the move back names it too', async () => {
    const before = new Date();
    const issue = await parked();
    ok(await answer(issue.questionId));
    await settleOutbox();

    expect(await statusOf(issue.id)).toBe('open');
    const events = ok(await say('owner', 'GET', `/api/issues/${issue.id}/events?kind=answer`));
    expect(events.items).toEqual([
      expect.objectContaining({
        kind: 'answer',
        fields: expect.arrayContaining([
          { key: 'question', value: issue.questionId },
          { key: 'round', value: '1' },
          { key: 'answer', value: 'the intake flow ships first' },
        ]),
      }),
    ]);
    const [moved] = await rows<{ reason: string | null; to_status: string }>(sql`
      SELECT reason, to_status FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${issue.id} ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    expect(moved).toMatchObject({ to_status: 'open' });
    expect(moved?.reason).toContain(issue.questionId);

    const { mastersPorts } = await import('../../src/masters/ports.js');
    const since = await mastersPorts().answersSince(projectId, before);
    expect(since).toContainEqual({
      issueKey: issue.key,
      questionId: issue.questionId,
      outcome: expect.objectContaining({ kind: 'resumed', to: 'open' }),
    });
    expect(await mastersPorts().answersSince(projectId, new Date())).toEqual([]);
  });

  it('carries what the answer says the issue still waits on', async () => {
    const issue = await parked();
    ok(await answer(issue.questionId, { stillWaits: { reason: 'the intake design lands first' } }));
    const events = ok(await say('owner', 'GET', `/api/issues/${issue.id}/events?kind=answer`));
    expect(events.items[0]?.fields).toContainEqual({
      key: 'still-waits',
      value: 'the intake design lands first',
    });
  });
});
