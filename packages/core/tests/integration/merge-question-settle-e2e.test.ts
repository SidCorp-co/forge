/**
 * A park that waits on a merge mark: the stamp writing the mark — a mark, a design approval recorded
 * as the landing — answers its question in the stamp's transaction, naming the mark, and the issue
 * moves on as an answer moves it; a mark that already stands, an issue elsewhere, and a park naming
 * two facts are refused by name, writing nothing.
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
import { seedProjectDocument } from '../helpers/release-world.js';

let projectId: string;
let otherProjectId: string;
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
  otherProjectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, {
    environments: { live: { tier: 'production', deployment: { mode: 'external' } } },
  });
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

let seq = 300;
/** An issue planted at a status under the kernel's flag; returns its id and key. */
async function plantIssue(
  status: string,
  opts: { mergedAt?: Date; sha?: string; project?: string } = {},
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
      VALUES (${id}, ${opts.project ?? projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId},
              ${opts.mergedAt?.toISOString() ?? null}::timestamptz, ${opts.sha ?? null})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

type QuestionRow = {
  id: string;
  status: string;
  awaits_merge_issue_id: string | null;
  needed: string | null;
  answer: string | null;
  answered_by: string | null;
};
const questionsOn = (issueId: string) =>
  rows<QuestionRow>(sql`
    SELECT id, status, awaits_merge_issue_id, steps -> -1 ->> 'needed' AS needed,
           steps -> -1 ->> 'answerText' AS answer, steps -> -1 ->> 'answeredBy' AS answered_by
      FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at, id
  `);
const statusOf = async (issueId: string) =>
  ok(await say('owner', 'GET', `/api/issues/${issueId}`)).status as string;
const park = (issueId: string, body: Doc, who: 'owner' | 'master' = 'master') =>
  say(who, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus: 'needs_info',
    reason: 'built and verified; the release waits for the landing to be recorded',
    waitingKind: 'needs_decision',
    ...body,
  });
const mark = (issueId: string, body: Doc = {}) =>
  say('owner', 'POST', `/api/issues/${issueId}/merge`, { target: 'main', ...body });

describe('the stamp writing the mark a park waits on answers its question', () => {
  it("answers a park on the issue's own mark when it is marked, naming the mark, and resumes it", async () => {
    const issue = await plantIssue('in_progress');
    ok(await park(issue.id, { awaitsMerge: { issueId: issue.id } }));
    const [asked] = await questionsOn(issue.id);
    expect(asked).toMatchObject({ status: 'open', awaits_merge_issue_id: issue.id });
    expect(asked?.needed).toContain(`the merge mark of ${issue.key}`);
    expect(ok(await say('owner', 'GET', `/api/questions/${asked?.id}`))).toMatchObject({
      awaitsMergeIssueId: issue.id,
      awaitsMerge: { issueId: issue.id, key: issue.key },
    });
    expect(await statusOf(issue.id)).toBe('needs_info');

    ok(await mark(issue.id, { mergedAt: '2026-10-06T18:32:00.000Z' }));
    const [settled] = await questionsOn(issue.id);
    expect(settled).toMatchObject({ status: 'answered', answered_by: ownerId });
    expect(settled?.answer).toBe(
      `The merge mark of ${issue.key} was recorded: a mark naming no commit and no landing at 2026-10-06T18:32:00.000Z.`,
    );
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('in_progress');
  });

  it("answers a park on another issue's mark when that one is marked, and leaves it alone before", async () => {
    const awaited = await plantIssue('in_progress');
    const parked = await plantIssue('in_progress');
    ok(await park(parked.id, { awaitsMerge: { issueId: awaited.id } }));
    const queue = ok(
      await say('owner', 'GET', `/api/questions?projectId=${projectId}&status=open`),
    );
    const listed = (queue.questions as Doc[]).find((q) => q.issueId === parked.id);
    expect(listed?.awaitsMerge).toEqual({ issueId: awaited.id, key: awaited.key });

    const unrelated = await plantIssue('in_progress');
    ok(await mark(unrelated.id));
    expect((await questionsOn(parked.id)).map((q) => q.status)).toEqual(['open']);

    ok(await mark(awaited.id));
    const [settled] = await questionsOn(parked.id);
    expect(settled?.status).toBe('answered');
    expect(settled?.answer).toContain(`The merge mark of ${awaited.key} was recorded`);
    await settleOutbox();
    expect(await statusOf(parked.id)).toBe('in_progress');
  });

  it('is answered by a design approval recorded as the landing, in its transaction', async () => {
    const issue = await plantIssue('in_progress');
    ok(await park(issue.id, { awaitsMerge: { issueId: issue.id } }));
    const { db } = await import('../../src/db/client.js');
    const { recordDesignLanding } = await import('../../src/issues/merge-record.js');
    await db.transaction((tx) =>
      recordDesignLanding(tx, {
        issueId: issue.id,
        landing: 'workflow design `intake` revision 2, approved',
        artifacts: [{ surface: 'design', ref: 'intake@rev2', change: 'changed' }],
        actor: { type: 'user', id: ownerId, agency: 'human' },
      }),
    );
    const [settled] = await questionsOn(issue.id);
    expect(settled?.status).toBe('answered');
    expect(settled?.answer).toContain(
      `The merge mark of ${issue.key} was recorded: landing workflow design \`intake\` revision 2, approved at `,
    );
    await settleOutbox();
    expect(await statusOf(issue.id)).toBe('in_progress');
  });

  it('answers nothing when the stamp is rolled back with its transaction', async () => {
    const issue = await plantIssue('in_progress');
    ok(await park(issue.id, { awaitsMerge: { issueId: issue.id } }));
    const { db } = await import('../../src/db/client.js');
    const { recordDesignLanding } = await import('../../src/issues/merge-record.js');
    await expect(
      db.transaction(async (tx) => {
        await recordDesignLanding(tx, {
          issueId: issue.id,
          landing: null,
          artifacts: [{ surface: 'design', ref: 'intake@rev3', change: 'changed' }],
          actor: { type: 'user', id: ownerId, agency: 'human' },
        });
        throw new Error('the caller refused after the stamp');
      }),
    ).rejects.toThrow('the caller refused after the stamp');
    expect((await questionsOn(issue.id)).map((q) => q.status)).toEqual(['open']);
  });
});

describe('a park may wait only on a mark still owed, of its own project', () => {
  it('refuses a mark that already stands, naming it, writing nothing', async () => {
    const issue = await plantIssue('in_progress', {
      mergedAt: new Date('2026-10-06T23:44:00.000Z'),
      sha: 'c'.repeat(40),
    });
    const res = await park(issue.id, { awaitsMerge: { issueId: issue.id } });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['QUESTION_MERGE_ALREADY_MARKED']);
    const said = JSON.stringify(res.json);
    expect(said).toContain(`${issue.key} already carries its merge mark`);
    expect(said).toContain(`commit ${'c'.repeat(40)} at 2026-10-06T23:44:00.000Z`);
    expect(await statusOf(issue.id)).toBe('in_progress');
    expect(await questionsOn(issue.id)).toEqual([]);
  });

  it('refuses an issue that is not of this project, or no issue at all, writing nothing', async () => {
    const issue = await plantIssue('in_progress');
    const elsewhere = await plantIssue('in_progress', { project: otherProjectId });
    for (const issueId of [elsewhere.id, randomUUID()]) {
      const res = await park(issue.id, { awaitsMerge: { issueId } });
      expect(res.status, JSON.stringify(res.json)).toBe(422);
      expect(codesOf(res)).toEqual(['QUESTION_MERGE_UNKNOWN']);
      expect(JSON.stringify(res.json)).toContain(issueId);
    }
    expect(await statusOf(issue.id)).toBe('in_progress');
    expect(await questionsOn(issue.id)).toEqual([]);
  });

  it('refuses awaitsMerge with awaitsDesign, on a move that mints no question, and from a person', async () => {
    const issue = await plantIssue('in_progress');
    const both = await park(issue.id, {
      awaitsMerge: { issueId: issue.id },
      awaitsDesign: { workflowId: randomUUID(), revision: 1 },
    });
    expect(both.status, JSON.stringify(both.json)).toBe(422);
    expect(codesOf(both)).toEqual(['NEEDS_NOT_APPLICABLE']);
    expect(JSON.stringify(both.json)).toContain('waits on one fact');
    const held = await say('master', 'POST', `/api/issues/${issue.id}/transition`, {
      toStatus: 'on_hold',
      reason: 'paused',
      awaitsMerge: { issueId: issue.id },
    });
    expect(held.status, JSON.stringify(held.json)).toBe(422);
    expect(codesOf(held)).toEqual(['NEEDS_NOT_APPLICABLE']);
    const byPerson = await park(issue.id, { awaitsMerge: { issueId: issue.id } }, 'owner');
    expect(byPerson.status, JSON.stringify(byPerson.json)).toBe(422);
    expect(codesOf(byPerson)).toEqual(['NEEDS_NOT_APPLICABLE']);
    expect(await statusOf(issue.id)).toBe('in_progress');
    expect(await questionsOn(issue.id)).toEqual([]);
  });
});
