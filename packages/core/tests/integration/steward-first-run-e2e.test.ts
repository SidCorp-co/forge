// REQ-48, the steward's first live run on dev.268. A stuck issue takes its note end to end, read back on
// the note door and on the standing. A feedback or requirement key sent to an issue tool is refused,
// naming the read it belongs to, before any door is called, and the run reads its own item by its
// kind. A note may cite the question the steward asked as a comment on a requirement.
//
// @direct-test-of packages/core/src/steward/door-kit.ts
// @direct-test-of packages/core/src/steward/doors.ts
// @direct-test-of packages/core/src/standing/cites.ts
// @direct-test-of packages/core/src/standing/read.ts
// @direct-test-of packages/core/src/steward-notes/routes.ts
// @direct-test-of packages/core/src/lib/issue-ref.ts

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
  createTestFeedback,
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

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let actAs: (
  act: StewardAct,
  subject: { kind: 'requirement' | 'issue' | 'feedback'; id: string; key: string },
) => Promise<{ acts: string[]; refused: string[]; error: string | null }>;
const at = (path: string) => `/api/projects/${projectId}${path}`;

async function agreedRequirement(as: 'owner', title: string): Promise<{ key: string; id: string }> {
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

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const stewardId = await stewardAccountOf(projectId);
  say = requester(app, { owner: await signUserToken(ownerId) });
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

describe('a stuck issue takes its note end to end (first live run: PUT …/steward-notes/issue/ISS-n)', () => {
  it('writes the note through the issue door, reads it back on the door and on the standing', async () => {
    const issue = await createTestIssue(projectId, ownerId, 70, {
      status: 'open',
      createdAt: new Date(),
    });
    const lines = [`${issue.key} waits for a master to take it on.`];
    resetScript();
    script.steps = [
      { tool: { name: 'steward_write_note', args: { lines } } },
      { text: 'Wrote the note.' },
    ];
    const out = await actAs('stuck_diagnosis', { kind: 'issue', ...issue });
    expect(out).toMatchObject({ refused: [], error: null });
    expect(out.acts).toHaveLength(1);
    const read = ok(await say('owner', 'GET', at(`/steward-notes/issue/${issue.key}`)));
    expect(read.note).toMatchObject({
      subject: { kind: 'issue', key: issue.key },
      lines,
      stale: false,
      cites: expect.arrayContaining([{ kind: 'issue', ref: issue.key }]),
    });
    const { openStandings } = await import('../../src/standing/index.js');
    const row = (await openStandings(projectId)).find((s) => s.subject.id === issue.id);
    expect(row?.note).toMatchObject({ lines, stale: false });
  });
});

describe('a key of another kind is refused at an issue tool by name, before any door (affordance)', () => {
  it('names the read a feedback or requirement key belongs to, and the run reads its own item', async () => {
    const issue = await createTestIssue(projectId, ownerId, 71, {
      status: 'open',
      createdAt: new Date(),
    });
    const fbKey = await createTestFeedback(projectId, ownerId, 71, [issue.id]);
    const [fb] = await rows<{ id: string }>(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = 71`);
    resetScript();
    script.steps = [
      { tool: { name: 'steward_read_issue', args: { issue: fbKey } } },
      {
        tool: {
          name: 'steward_comment_issue',
          args: { issue: 'REQ-1', body: 'Asked the master.' },
        },
      },
      {
        tool: {
          name: 'steward_ask',
          args: {
            about: fbKey,
            prompt: 'Should the carrier be taken on now?',
            options: [
              { id: 'a', label: 'Take it on' },
              { id: 'b', label: 'Wait' },
            ],
            recommended: 'a',
          },
        },
      },
      { tool: { name: 'steward_read_item', args: {} } },
      { text: 'Read the item.' },
    ];
    const out = await actAs('stuck_diagnosis', { kind: 'feedback', id: fb?.id ?? '', key: fbKey });
    // a refused shape is the turn's to correct, never a door's refusal on the run
    expect(out).toMatchObject({ refused: [], error: null, acts: [] });
    // each tool result, in the order the turn called them
    const results = (script.sent.at(-1) ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
    expect(results).toHaveLength(4);
    expect(results[0]).toContain(
      `${fbKey} is a feedback item, not an issue: read it with steward_read_feedback`,
    );
    expect(results[1]).toContain(
      'REQ-1 is a requirement, not an issue: read it with steward_read_requirement',
    );
    expect(results[2]).toContain(`${fbKey} is a feedback item, which takes no question here`);
    // the item read answers the run's own feedback item, its carrier on the route
    expect(results[3]).toContain(fbKey);
    expect(results[3]).toContain(issue.key);
  });

  it('names the feedback read where an FB key reaches the issue door itself', async () => {
    const read = await say('owner', 'GET', `/api/issues/FB-110?projectId=${projectId}`);
    expect(read.status).toBe(400);
    expect(JSON.stringify(read.json)).toContain(
      "is a feedback item's key, not an issue's: read it at GET /api/projects/<project>/feedback/<key>",
    );
  });
});

describe('a note cites the question the steward asked as a requirement comment (STEWARD_NOTE_CITE_UNKNOWN)', () => {
  it('takes the comment as a question and as a comment, and still refuses an id nobody wrote', async () => {
    const req = await agreedRequirement('owner', 'Ward boards read by bed');
    const asked = ok(
      await say('owner', 'POST', at(`/requirements/${req.key}/comments`), {
        intent: 'question',
        body: 'Which ward goes first? Options: a: north; b: south. Recommended: a.',
      }),
      201,
    );
    const commentId = (asked.comment as Doc).id as string;
    const note = (cites: { kind: string; ref: string }[]) =>
      say('owner', 'GET', at(`/steward-notes/requirement/${req.key}`)).then(async () => {
        const { standingOfSubject } = await import('../../src/standing/index.js');
        const standing = await standingOfSubject(projectId, 'requirement', req.key);
        if (!standing) throw new Error('no standing');
        const { noteWriteOf } = await import('../../src/steward/note.js');
        const body = noteWriteOf(
          standing,
          [`${req.key} waits on the ward order.`],
          cites as never,
          null,
        );
        return say('owner', 'PUT', at(`/steward-notes/requirement/${req.key}`), body);
      });
    expect((await note([{ kind: 'question', ref: commentId }])).status).toBe(200);
    expect((await note([{ kind: 'comment', ref: commentId }])).status).toBe(200);
    const nobody = await note([{ kind: 'question', ref: '00000000-0000-4000-8000-000000000000' }]);
    expect([nobody.status, nobody.json.code]).toEqual([422, 'STEWARD_NOTE_CITE_UNKNOWN']);
  });
});
