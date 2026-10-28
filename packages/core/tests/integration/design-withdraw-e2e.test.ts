/**
 * A design that was never approved is withdrawn by whoever may write designs: it leaves the
 * workflows list and Needs you, its own page still reads it as withdrawn, and the kernel ledger holds
 * the move. An approved design is history and is refused by name, as is a design another live design
 * builds on, a second withdraw, and a caller who may not write designs.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusalCodes,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let say: (
  who: 'owner' | 'master' | 'viewer',
  method: string,
  path: string,
  body?: Doc,
) => Promise<Reply>;

const design = (flow: string, basedOn?: Doc[]): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  if (basedOn) d.basedOn = basedOn;
  return d;
};

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
  const viewerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewerId, 'viewer');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    viewer: await signUserToken(viewerId),
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

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function proposed(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  const id = made.document.id as string;
  ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  return id;
}

const withdraw = (id: string, who: 'owner' | 'master' | 'viewer' = 'master', body: Doc = {}) =>
  say(who, 'POST', at(`/workflows/${id}/design/withdraw`), body);
const read = async (id: string) => ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
const listed = async () =>
  (ok(await say('owner', 'GET', at('/workflows'))).workflows as Doc[]).map(
    (w) => w.document.flow as string,
  );
const owed = async () =>
  (ok(await say('owner', 'GET', at('/needs-you/decisions'))).decisions as Doc[])
    .filter((d) => d.entity === 'workflow')
    .map((d) => d.key as string);
const moves = async (id: string) =>
  (await db.execute(sql`
    SELECT from_status, to_status, reason FROM kernel_transitions
     WHERE entity = 'workflow_design' AND entity_id = ${id}
     ORDER BY created_at`)) as unknown as {
    from_status: string;
    to_status: string;
    reason: string | null;
  }[];

/** An issue planted open under the kernel's flag, to park on a design. */
async function plantIssue(): Promise<string> {
  const id = randomUUID();
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, 900, 'parked on a throwaway design', 'open', ${ownerId})
    `),
  );
  return id;
}

describe('withdrawing a design that was never approved', () => {
  it('takes it off the list and Needs you, keeps its page, and logs the kernel move', async () => {
    const id = await proposed('qa-throwaway');
    expect(await listed()).toContain('qa-throwaway');
    expect(await owed()).toContain('qa-throwaway');

    const done = ok(await withdraw(id, 'master', { reason: 'a QA judge drew it to test a gate' }));
    expect(done).toMatchObject({ workflowId: id, status: 'withdrawn', proposedRevision: null });

    expect(await listed()).not.toContain('qa-throwaway');
    expect(await owed()).not.toContain('qa-throwaway');
    expect((await read(id)).status).toBe('withdrawn');
    expect((await moves(id)).at(-1)).toEqual({
      from_status: 'proposed',
      to_status: 'withdrawn',
      reason: 'a QA judge drew it to test a gate',
    });
  });

  it('answers a question parked on its waiting revision, since no decision will come', async () => {
    const id = await proposed('parked-on-throwaway');
    const issue = await plantIssue();
    ok(
      await say('master', 'POST', `/api/issues/${issue}/transition`, {
        toStatus: 'needs_info',
        reason: 'the build waits on the design approval',
        waitingKind: 'needs_decision',
        awaitsDesign: { workflowId: id, revision: 1 },
      }),
    );
    ok(await withdraw(id, 'master', { reason: 'drawn by a QA judge' }));
    const [question] = await rows<{ status: string; answer: string | null }>(sql`
      SELECT status, steps -> -1 ->> 'answerText' AS answer
        FROM agent_questions WHERE issue_id = ${issue} ORDER BY created_at DESC LIMIT 1`);
    expect(question).toEqual({
      status: 'answered',
      answer:
        'Design `parked-on-throwaway` revision 1 was withdrawn before anyone decided it, so no decision will come: drawn by a QA judge',
    });
  });

  it('is refused by name when a requirement would be drawn with it, by flow or by id', async () => {
    const id = await proposed('never-a-requirement-design');
    ok(await withdraw(id));

    const drafted = await say('owner', 'POST', at('/requirements'), {
      title: 'A requirement drawn with a withdrawn design',
      designs: ['never-a-requirement-design'],
    });
    expect(drafted.status, JSON.stringify(drafted.json)).toBe(409);
    expect(drafted.json.error.refusals).toEqual([
      expect.objectContaining({ code: 'WORKFLOW_DESIGN_WITHDRAWN', path: '/designs/0' }),
    ]);
    expect(drafted.json.error.refusals[0].detail).toContain('never-a-requirement-design');
    expect(drafted.json.error.refusals[0].detail).toContain('withdrawn');

    const req = ok(
      await say('owner', 'POST', at('/requirements'), { title: 'A requirement linked later' }),
      201,
    );
    const linked = await say('owner', 'POST', at(`/requirements/${req.key}/workflows`), {
      workflowId: id,
    });
    expect(linked.status, JSON.stringify(linked.json)).toBe(409);
    expect(linked.json.error.refusals).toEqual([
      expect.objectContaining({ code: 'WORKFLOW_DESIGN_WITHDRAWN', path: '/workflowId' }),
    ]);
    const [held] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM requirement_workflows WHERE workflow_id = ${id}`);
    expect(held?.n).toBe(0);
  });

  it('refuses a second withdraw by name', async () => {
    const id = await proposed('twice-withdrawn');
    ok(await withdraw(id));
    const again = await withdraw(id);
    expect(again.status, JSON.stringify(again.json)).toBe(409);
    expect(refusalCodes(again)).toEqual(['DESIGN_ALREADY_WITHDRAWN']);
  });

  it('refuses a design with an approved revision, and changes nothing', async () => {
    const id = await proposed('approved-history');
    ok(
      await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
        revision: 1,
        decision: 'approve',
      }),
    );
    const before = await moves(id);
    const refused = await withdraw(id);
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refused.json.error.refusals).toEqual([
      expect.objectContaining({
        code: 'DESIGN_WITHDRAW_APPROVED',
        path: '/design/status',
        approvedRevision: 1,
      }),
    ]);
    expect(refused.json.error.refusals[0].detail).toContain('revision 1');
    expect((await read(id)).status).toBe('approved');
    expect(await moves(id)).toEqual(before);
    expect(await listed()).toContain('approved-history');
  });

  it('refuses a base another live design pins, naming that design', async () => {
    const base = await proposed('pinned-base');
    await proposed('pins-the-base', [{ workflow: 'pinned-base', revision: 1 }]);
    const refused = await withdraw(base);
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refused.json.error.refusals).toEqual([
      expect.objectContaining({ code: 'DESIGN_WITHDRAW_PINNED', pinnedBy: ['pins-the-base'] }),
    ]);
    expect(refused.json.error.refusals[0].detail).toContain('pins-the-base');
    expect((await read(base)).status).toBe('proposed');
  });

  it('lets a base go once the design pinning it is withdrawn', async () => {
    const base = await proposed('freed-base');
    const dependent = await proposed('withdrawn-dependent', [
      { workflow: 'freed-base', revision: 1 },
    ]);
    ok(await withdraw(dependent));
    expect(ok(await withdraw(base)).status).toBe('withdrawn');
  });

  it('refuses a caller who may not write designs', async () => {
    const id = await proposed('viewer-cannot');
    const refused = await withdraw(id, 'viewer');
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    expect((await read(id)).status).toBe('proposed');
  });

  it('refuses a body with fields it does not take', async () => {
    const id = await proposed('strict-body');
    const refused = await withdraw(id, 'master', { reason: 'x', revision: 1 });
    expect(refused.status, JSON.stringify(refused.json)).toBe(400);
    expect((await read(id)).status).toBe('proposed');
  });
});

// 2026-10-28: every write door under /workflows/:workflow takes the workflow's id, and a list row
// named it only inside its document, so a caller read the id from the database to act on a row
describe('a listed workflow names the id its write doors take', () => {
  it('carries workflowId on every row, in both views, and a write door takes it', async () => {
    const id = await proposed('qa-listed-id');

    const full = (ok(await say('master', 'GET', at('/workflows'))).workflows as Doc[]).find(
      (w) => w.document.flow === 'qa-listed-id',
    );
    expect(full?.workflowId).toBe(id);
    const summary = (
      ok(await say('master', 'GET', at('/workflows?view=summary'))).workflows as Doc[]
    ).find((w) => w.flow === 'qa-listed-id');
    expect(summary?.workflowId).toBe(id);

    ok(await withdraw(full?.workflowId as string));
    expect(await listed()).not.toContain('qa-listed-id');
  });
});
