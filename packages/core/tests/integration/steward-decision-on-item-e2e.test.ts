// REQ-68 BC-4 (ISS-687): a stuck issue reaches a person only as a decision on its item. The steward's
// stuck_diagnosis decision on an issue names, under `about`, the requirement the issue delivers, else
// the feedback item it carries, so the item's own page lists it and its answer is recorded there. A
// decision on an issue serving neither is the master's: asked of a person (strict, serious) it is
// refused STEWARD_DECISION_ITEM_NONE and nothing is written; left to the master, it stays on the issue.
//
// @direct-test-of packages/core/src/steward/decision-ask.ts

import { STEWARD_DECISION_OPTION_IDS as IDS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  completeIssueReadyRecord,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { underStrict } from '../helpers/project-controls.js';

let say: (who: 'owner' | 'steward', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let runId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;

const ask = (about: string, serious = false) =>
  say('steward', 'POST', at(`/steward-runs/${runId}/decisions`), {
    about,
    prompt: 'Keep it as a draft, or drop it?',
    options: [
      { id: IDS.keep, label: 'Keep it as a draft' },
      { id: IDS.drop, label: 'Drop it: it is not work' },
    ],
    recommendedOptionId: IDS.drop,
    why: 'nothing has moved it in sixteen days',
    basis: 'standing.stuck',
    ...(serious ? { serious: true } : {}),
  });

const questionsOn = (issueId: string) =>
  rows<{ id: string; about: Doc | null }>(sql`
    SELECT id, about FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at`);

const draft = (seq: number) =>
  createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  const stewardId = await stewardAccountOf(projectId);
  const stewardToken = (
    await mintStewardCredential({
      projectId,
      stewardId,
      acts: ['stuck_diagnosis'],
      ttlMs: 30 * 60_000,
    })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId), steward: stewardToken });
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, not_before, started_at, ended_at)
    VALUES (${projectId}, 'issue', gen_random_uuid(), 'ISS-1', 'standing.stuck', '[]'::jsonb,
            ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
    RETURNING id`);
  runId = made?.id ?? '';
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a stuck issue's decision is asked on its item (REQ-68 BC-4)", () => {
  it('names the requirement the issue delivers, and that requirement lists it', async () => {
    const issue = await draft(301);
    await completeIssueReadyRecord(projectId, ownerId, issue.id, 951);
    const [req] = await rows<{ id: string }>(
      sql`SELECT requirement_id AS id FROM issues WHERE id = ${issue.id}`,
    );
    ok(await ask(issue.key), 201);
    const [q] = await questionsOn(issue.id);
    expect(q?.about).toEqual({ kind: 'requirement', requirementId: req?.id });
    const { questionsOnRequirement } = await import('../../src/questions/index.js');
    const { db } = await import('../../src/db/client.js');
    const listed = await questionsOnRequirement(req?.id ?? '', db);
    expect(listed.map((l) => l.id)).toContain(q?.id);
  });

  it('names the feedback item the issue carries, and that item lists it', async () => {
    const fb = (
      ok(
        await say('owner', 'POST', at('/feedback'), {
          kind: 'bug',
          title: 'The board loses its cards',
          screen: 'The board',
        }),
        201,
      ).feedback as Doc
    ).key as string;
    ok(
      await say('owner', 'POST', at(`/feedback/${fb}/triage`), {
        route: 'issue',
        createIssue: {},
        answers: { criterion: 'none', severity: 'medium', reproduced: 'Saved twice, cards gone.' },
      }),
    );
    const [carried] = await rows<{ issue_id: string; feedback_id: string; key: string }>(sql`
      SELECT r.issue_id, r.feedback_id, 'ISS-' || i.iss_seq AS key
        FROM feedback_route_issues r JOIN issues i ON i.id = r.issue_id
        JOIN feedback f ON f.id = r.feedback_id
       WHERE f.project_id = ${projectId} AND 'FB-' || f.fb_seq = ${fb}`);
    expect(carried).toBeDefined();
    ok(await ask(carried?.key ?? ''), 201);
    const [q] = await questionsOn(carried?.issue_id ?? '');
    expect(q?.about).toEqual({ kind: 'feedback', feedbackId: carried?.feedback_id });
    const { questionsOnFeedback } = await import('../../src/feedback/questions-read.js');
    const { db } = await import('../../src/db/client.js');
    const listed = await questionsOnFeedback(db, carried?.feedback_id ?? '');
    expect(listed.map((l) => l.id)).toContain(q?.id);
  });

  it("refuses a person's decision on an issue that serves no item, by name, writing nothing", async () => {
    const issue = await draft(302);
    const res = await underStrict(projectId, ownerId, () => ask(issue.key, true));
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    const refusal = ((res.json.error as Doc).refusals as Doc[])[0] as Doc;
    expect(refusal.code).toBe('STEWARD_DECISION_ITEM_NONE');
    expect(refusal.path).toBe('/about');
    expect(await questionsOn(issue.id)).toHaveLength(0);
  });

  it('leaves the decision on an issue that serves no item to the master, on the issue', async () => {
    const issue = await draft(303);
    ok(await ask(issue.key), 201);
    const [q] = await questionsOn(issue.id);
    expect(q?.about).toBeNull();
    const [owed] = await rows<{ blocker_kind: string }>(
      sql`SELECT blocker_kind FROM agent_questions WHERE id = ${q?.id ?? ''}`,
    );
    expect(owed?.blocker_kind).toBe('master_or_peer');
  });
});
