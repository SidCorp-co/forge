// REQ-48 lane B, the coordinator's rulings of 2026-10-21: the steward holds `suggestions.approve` to
// reject a breakdown and never accepts one, and the three doors its acts and their undo needed exist:
// a requirement's owner (`PATCH …/requirements/:req`), a question's void (`POST /api/questions/:id/void`)
// and a requirement comment's delete (`DELETE …/requirements/:req/comments/:comment`). Each door
// refuses by name what it does not take, and each steward act on them is undone through its inverse.
//
// @direct-test-of packages/core/src/suggestions/accept-fence.ts
// @direct-test-of packages/core/src/requirements/owner.ts
// @direct-test-of packages/core/src/questions/void-door.ts
// @direct-test-of packages/core/src/comments/entity-delete.ts
// @direct-test-of packages/core/src/steward/door-owner.ts
// @direct-test-of packages/core/src/steward/door-writes.ts

import type { StewardAct } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

type Who = 'owner' | 'member' | 'viewer' | 'outsider' | 'steward' | 'stewardNote';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let memberId = '';
let outsiderId = '';
let stewardId = '';
let actAs: (
  act: StewardAct,
  subject: { kind: 'requirement' | 'issue'; id: string; key: string },
) => Promise<{ acts: string[]; refused: string[]; error: string | null }>;
const at = (path: string) => `/api/projects/${projectId}${path}`;

async function agreedRequirement(as: Who, title: string): Promise<{ key: string; id: string }> {
  const key = ok(
    await say(as, 'POST', at('/requirements'), {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  ok(
    await say('owner', 'POST', at(`/requirements/${key}/revisions/1/accept`), {
      reason: 'BA review',
    }),
  );
  ok(
    await say('owner', 'POST', at(`/requirements/${key}/agree`), {
      revision: 1,
      reason: 'signed r1',
    }),
  );
  const id = (ok(await say('owner', 'GET', at(`/requirements/${key}`))) as Doc).id as string;
  return { key, id };
}

async function breakdownOf(req: string): Promise<string> {
  const made = ok(
    await say('owner', 'POST', at('/suggestions'), {
      kind: 'breakdown',
      requirement: req,
      baseRevision: 1,
      payload: {
        issues: [
          {
            title: 'Save every card',
            criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
            complexity: 's',
            builds: null,
          },
        ],
      },
    }),
    201,
  );
  return (made.suggestion as Doc).id as string;
}

const actRow = (id: string) =>
  rows<{ id: string; door: string; undo: { door: string } | null }>(sql`
    SELECT id, door, undo FROM steward_acts WHERE id = ${id}`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  const viewerId = (await createTestUser({ verified: true })).id;
  outsiderId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, memberId, 'member');
  await addProjectMember(projectId, viewerId, 'viewer');
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  stewardId = await stewardAccountOf(projectId);
  const token = async (acts: StewardAct[]) =>
    (await mintStewardCredential({ projectId, stewardId, acts, ttlMs: 30 * 60_000 })).token;
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(memberId),
    viewer: await signUserToken(viewerId),
    outsider: await signUserToken(outsiderId),
    steward: await token(['breakdown_check']),
    stewardNote: await token(['note']),
  });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  actAs = async (act, subject) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, ${subject.kind}, ${subject.id}, ${subject.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY[${act}]::text[], 'done', now(), now(), now())
      RETURNING id`);
    const [run] = await db
      .select()
      .from(stewardRuns)
      .where(eq(stewardRuns.id, made?.id ?? ''));
    if (!run) throw new Error('the run row was not written');
    return runGatewayAct({ run, act, standing: null, stewardId });
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the steward rejects a breakdown and never accepts one (decision 2, amended)', () => {
  it('refuses the steward accepting a breakdown by name, and takes its rejection', async () => {
    const req = await agreedRequirement('owner', 'The board keeps its cards');
    const first = await breakdownOf(req.key);
    const accepted = await say('steward', 'POST', at(`/suggestions/${first}/accept`), {});
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(403);
    expect(JSON.stringify(accepted.json)).toContain(
      "The project's steward accepts only the feedback triage it proposed itself",
    );
    const [still] = await rows<{ status: string }>(
      sql`SELECT status FROM suggestions WHERE id = ${first}`,
    );
    expect(still?.status).toBe('proposed');

    const rejected = await say('steward', 'POST', at(`/suggestions/${first}/reject`), {
      reason: 'BC-1 untraced by any issue criterion',
    });
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(200);
  });

  it('lets an act whose token names no approval reject nothing', async () => {
    const req = await agreedRequirement('owner', 'The board shows its owner');
    const second = await breakdownOf(req.key);
    const refused = await say('stewardNote', 'POST', at(`/suggestions/${second}/reject`), {
      reason: 'a note act tried to decide',
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('suggestions.approve');
  });
});

describe("a requirement's owner is a member or nobody (PATCH …/requirements/:req)", () => {
  let req: { key: string; id: string };

  it('names a member, clears to null, and refuses a non-member by name', async () => {
    req = await agreedRequirement('member', 'The board names who owns it');
    const set = ok(
      await say('owner', 'PATCH', at(`/requirements/${req.key}`), { owner: memberId }),
    );
    expect((set.standing as Doc).owner?.id).toBe(memberId);
    const cleared = ok(
      await say('owner', 'PATCH', at(`/requirements/${req.key}`), { owner: null }),
    );
    expect((cleared.standing as Doc).owner).toBeNull();

    const outsider = await say('owner', 'PATCH', at(`/requirements/${req.key}`), {
      owner: outsiderId,
    });
    expect(outsider.status).toBe(422);
    expect(outsider.json.code).toBe('REQUIREMENT_OWNER_NOT_MEMBER');
    expect(JSON.stringify(outsider.json)).toContain(outsiderId);
    const [row] = await rows<{ owner_id: string | null }>(
      sql`SELECT owner_id FROM requirements WHERE id = ${req.id}`,
    );
    expect(row?.owner_id).toBeNull();

    const viewer = await say('viewer', 'PATCH', at(`/requirements/${req.key}`), {
      owner: memberId,
    });
    expect(viewer.status).toBe(403);
  });

  it('names the author as owner where nobody owns it, and its undo sets nobody again', async () => {
    resetScript();
    script.steps = [
      { tool: { name: 'steward_set_requirement_owner', args: { requirement: req.key } } },
      { text: 'Named the author as owner.' },
    ];
    const out = await actAs('stuck_diagnosis', { kind: 'requirement', ...req });
    expect(out).toMatchObject({ refused: [], error: null });
    expect(out.acts).toHaveLength(1);
    const [row] = await rows<{ owner_id: string | null }>(
      sql`SELECT owner_id FROM requirements WHERE id = ${req.id}`,
    );
    expect(row?.owner_id).toBe(memberId);
    const [act] = await actRow(out.acts[0] ?? '');
    expect(act?.undo?.door).toBe(`PATCH /api/projects/${projectId}/requirements/${req.key}`);

    const undone = await say('owner', 'POST', at(`/steward-acts/${act?.id}/undo`));
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    const [after] = await rows<{ owner_id: string | null }>(
      sql`SELECT owner_id FROM requirements WHERE id = ${req.id}`,
    );
    expect(after?.owner_id).toBeNull();
  });
});

describe('a requirement comment is deleted by its author or a project.write holder', () => {
  let req: { key: string; id: string };
  const comment = async (who: Who, body: Doc) =>
    (ok(await say(who, 'POST', at(`/requirements/${req.key}/comments`), body), 201).comment as Doc)
      .id as string;
  const del = (who: Who, id: string) =>
    say(who, 'DELETE', at(`/requirements/${req.key}/comments/${id}`));
  const left = async (id: string) =>
    (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM comments WHERE id = ${id}`))[0]
      ?.n;

  it("takes its author's delete and a writer's, and refuses a viewer's by name", async () => {
    req = await agreedRequirement('owner', 'The board keeps its comments');
    const mine = await comment('member', { intent: 'note', body: 'The member wrote this.' });
    expect((await del('viewer', mine)).status).toBe(403);
    expect(await left(mine)).toBe(1);
    expect((await del('member', mine)).status).toBe(204);
    expect(await left(mine)).toBe(0);

    const theirs = await comment('member', { intent: 'note', body: 'Another note by the member.' });
    expect((await del('owner', theirs)).status).toBe(204);
    expect(await left(theirs)).toBe(0);
  });

  it('keeps a decision and a comment somebody replied to, refused by name', async () => {
    const decided = await comment('owner', {
      intent: 'decision',
      decision: { decision: 'Keep cards on reload', reason: 'BC-1 says so' },
    });
    const kept = await del('owner', decided);
    expect([kept.status, kept.json.code]).toEqual([422, 'COMMENT_RECORD_KEPT']);

    const asked = await comment('owner', { intent: 'question', body: 'Which board?' });
    await comment('member', { intent: 'note', body: 'The saved one.', parentId: asked });
    const replied = await del('owner', asked);
    expect([replied.status, replied.json.code]).toEqual([422, 'COMMENT_HAS_REPLIES']);
    expect(await left(asked)).toBe(1);
  });

  it("undoes the steward's intake question and its brief through the delete door", async () => {
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_ask',
          args: {
            about: req.key,
            prompt: 'Which board does BC-1 mean, saved or shared?',
            options: [
              { id: 'a', label: 'The saved board' },
              { id: 'b', label: 'The shared board' },
            ],
            recommended: 'a',
          },
        },
      },
      {
        tool: {
          name: 'steward_comment_requirement',
          args: { requirement: req.key, body: 'Breakdown brief: one issue per BC.' },
        },
      },
      { text: 'Asked and briefed.' },
    ];
    const out = await actAs('intake_check', { kind: 'requirement', ...req });
    expect(out).toMatchObject({ refused: [], error: null });
    expect(out.acts).toHaveLength(2);
    for (const actId of out.acts) {
      const [act] = await actRow(actId);
      expect(act?.undo?.door).toMatch(
        new RegExp(
          `^DELETE /api/projects/${projectId}/requirements/${req.key}/comments/[0-9a-f-]{36}$`,
        ),
      );
      const commentId = act?.undo?.door.split('/').at(-1) ?? '';
      expect(await left(commentId)).toBe(1);
      const undone = await say('member', 'POST', at(`/steward-acts/${actId}/undo`));
      expect(undone.status, JSON.stringify(undone.json)).toBe(200);
      expect(await left(commentId)).toBe(0);
    }
  });
});

describe('an open question is voided with its reason (POST /api/questions/:id/void)', () => {
  let issue: { id: string; key: string };
  const ask = async () =>
    ok(
      await say('owner', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'Ship it now or with the next batch?',
        options: [
          {
            id: 'now',
            label: 'Now',
            authority: 'writer',
            bindsTo: 'this_call',
            executedBy: 'human',
            fingerprint: 'ship:now',
          },
          {
            id: 'later',
            label: 'Later',
            authority: 'writer',
            bindsTo: 'this_call',
            executedBy: 'human',
            fingerprint: 'ship:later',
          },
        ],
        recommendedOptionId: 'now',
      }),
      201,
    ).id as string;
  const statusOf = async (id: string) =>
    (
      await rows<{ status: string; void_reason: string | null }>(sql`
      SELECT status, void_reason FROM agent_questions WHERE id = ${id}`)
    )[0];

  it("voids an open question with the writer's reason, once, and refuses a viewer and an outsider", async () => {
    issue = await createTestIssue(projectId, ownerId, 60, {
      status: 'open',
      createdAt: new Date(),
    });
    const q = await ask();
    expect(
      (await say('viewer', 'POST', `/api/questions/${q}/void`, { reason: 'not needed' })).status,
    ).toBe(403);
    expect(
      (await say('outsider', 'POST', `/api/questions/${q}/void`, { reason: 'not needed' })).status,
    ).toBe(404);
    const voided = await say('member', 'POST', `/api/questions/${q}/void`, {
      reason: 'Shipped already.',
    });
    expect(voided.status, JSON.stringify(voided.json)).toBe(200);
    expect(await statusOf(q)).toEqual({ status: 'void', void_reason: 'Shipped already.' });
    const again = await say('member', 'POST', `/api/questions/${q}/void`, { reason: 'again' });
    expect([again.status, again.json.code]).toEqual([422, 'QUESTION_NOT_OPEN']);
  });

  it("refuses to void its issue's park question by name", async () => {
    const parked = await createTestIssue(projectId, ownerId, 61, {
      status: 'needs_info',
      waitingKind: 'needs_answer',
      createdAt: new Date(),
    });
    const before = issue;
    issue = parked;
    const q = await ask();
    issue = before;
    await rows(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      SELECT 'issue', ${parked.id}, 'in_progress', 'needs_info', 'user', 'agent', ${ownerId}, 'planted', created_at
        FROM agent_questions WHERE id = ${q}`);
    const refused = await say('owner', 'POST', `/api/questions/${q}/void`, { reason: 'try it' });
    expect([refused.status, refused.json.code]).toEqual([422, 'QUESTION_IS_PARK']);
    expect((await statusOf(q))?.status).toBe('open');
  });

  it("undoes the steward's question on an issue through the void door, once", async () => {
    const draft = await createTestIssue(projectId, ownerId, 64, {
      status: 'draft',
      createdAt: new Date(),
    });
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_decide',
          args: { issue: draft.key, recommended: 'keep', why: 'nothing asks for it yet' },
        },
      },
      { text: 'Asked.' },
    ];
    const out = await actAs('stuck_diagnosis', { kind: 'issue', ...draft });
    expect(out).toMatchObject({ refused: [], error: null });
    const [act] = await actRow(out.acts[0] ?? '');
    expect(act?.undo?.door).toMatch(/^POST \/api\/questions\/[0-9a-f-]{36}\/void$/);
    const questionId = act?.undo?.door.split('/')[3] ?? '';
    expect((await statusOf(questionId))?.status).toBe('open');

    const undone = await say('owner', 'POST', at(`/steward-acts/${act?.id}/undo`));
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(await statusOf(questionId)).toMatchObject({ status: 'void' });
    const again = await say('owner', 'POST', at(`/steward-acts/${act?.id}/undo`));
    expect([again.status, again.json.code]).toEqual([409, 'STEWARD_ACT_SUPERSEDED']);
  });
});

describe('a person authorises an undo, and the steward executes its inverse', () => {
  it("lets a project.write member undo the steward's issue comment, refuses a viewer, and records who asked", async () => {
    const issue = await createTestIssue(projectId, ownerId, 62, {
      status: 'reopen',
      createdAt: new Date(),
    });
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_comment_issue',
          args: { issue: issue.key, body: 'No master serves this project; the master was asked.' },
        },
      },
      { text: 'Commented.' },
    ];
    const out = await actAs('stuck_diagnosis', { kind: 'issue', ...issue });
    expect(out).toMatchObject({ refused: [], error: null });
    const actId = out.acts[0] ?? '';
    const comments = () =>
      rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issue.id}`,
      );
    expect((await comments())[0]?.n).toBe(1);

    const viewer = await say('viewer', 'POST', at(`/steward-acts/${actId}/undo`));
    expect(viewer.status).toBe(403);
    expect((await comments())[0]?.n).toBe(1);

    const member = await say('member', 'POST', at(`/steward-acts/${actId}/undo`));
    expect(member.status, JSON.stringify(member.json)).toBe(200);
    expect(member.json.act.undoneBy).toBe(memberId);
    expect((await comments())[0]?.n).toBe(0);
  });
});
