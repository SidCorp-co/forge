// REQ-34 r2 on Requirement lifecycle r15, ISS-456: a title alone creates a requirement and its reason
// is asked, not required (BC-17); its author is told at every step change, the delivery phases
// included (BC-21); and Needs you lists a gated step only for the member who must take it, proven with
// two members of whom only one holds the act (BC-22).

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let projectId: string;
let adminId: string;
let admin: string;
let memberId: string;
let member: string;

const on = (token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

beforeAll(async () => {
  const { registerRequirementNotifications } = await import(
    '../../src/notifications/notify-requirements.js'
  );
  const { registerReasonAnswers } = await import('../../src/requirements/reason-question.js');
  registerRequirementNotifications();
  registerReasonAnswers();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  adminId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(adminId)).id;
  admin = await userToken(adminId);
  // the member holds project.write and not requirements.approve; the admin holds both
  memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
  await seedProjectDocument(projectId, adminId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
  });
});

async function deliver(type: string, consumer: string, requirementId?: string): Promise<number> {
  const { consumerOf } = await import('../../src/outbox/consumers.js');
  const events = await rows<{ id: string; payload: Record<string, unknown> }>(sql`
    SELECT id, payload FROM pipeline_outbox WHERE type = ${type}
       AND (${requirementId ?? null}::text IS NULL OR payload ->> 'id' = ${requirementId ?? null}
            OR payload ->> 'requirementId' = ${requirementId ?? null})
     ORDER BY created_at`);
  for (const e of events) {
    await consumerOf(type as never, consumer)?.handle(
      e.payload as never,
      { eventId: e.id } as never,
    );
  }
  return events.length;
}

const notices = (userId: string) =>
  rows<{ title: string; body: string | null }>(sql`
    SELECT n.title, n.body FROM notifications n
      JOIN notification_delivery_members m ON m.notification_id = n.id
      JOIN notification_deliveries d ON d.id = m.delivery_id
     WHERE n.project_id = ${projectId} AND n.type = 'requirement_step' AND d.user_id = ${userId}
     ORDER BY n.created_at`);

async function detail(token: string, key: string): Promise<Body> {
  const r = await on(token, 'GET', `/requirements/${key}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** A requirement the member creates from its title, made agree-ready and its revision 1 current. */
async function readyByMember(title: string): Promise<{ key: string; id: string }> {
  // a criterion is what a proposal asks (REQUIREMENT_REVISION_EMPTY); the reason is still left out
  const made = await on(member, 'POST', '/requirements', {
    title,
    criteria: [{ body: 'A nurse sees it' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = String(made.body.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), memberId);
  for (const path of [
    `/requirements/${key}/revisions/1/propose`,
    `/requirements/${key}/revisions/1/accept`,
  ]) {
    const r = await on(member, 'POST', path, {});
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  return { key, id: String(made.body.id) };
}

describe('a requirement is created from a title alone (BC-17)', () => {
  it('writes REQ-n with no reason and asks its author why, a question that blocks nothing', async () => {
    const made = await on(member, 'POST', '/requirements', { title: 'Cards export to CSV' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = String(made.body.key);
    const d = await detail(member, key);
    const [r1] = d.revisions as Body[];
    expect(r1?.reason).toBeNull();
    const asked = (d.questions as Body[]).find(
      (q) => q.prompt === `Why is ${key} needed? It was created without a reason.`,
    );
    expect(asked, JSON.stringify(d.questions)).toMatchObject({
      status: 'open',
      blocking: false,
      whoAnswers: 'its author',
    });
    expect((d.standing as Body).state).toBe('draft');
    expect((d.standing as Body).next).toBe('agreed');
  });

  it('a blank reason is no refusal, and a reason given asks nothing', async () => {
    const blank = await on(member, 'POST', '/requirements', {
      title: 'Cards print',
      reason: '  ',
      criteria: [],
    });
    expect(blank.status, JSON.stringify(blank.body)).toBe(201);
    const given = await on(member, 'POST', '/requirements', {
      title: 'Cards archive',
      reason: 'Old cards crowd the board',
    });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    const d = await detail(member, String(given.body.key));
    expect((d.revisions as Body[])[0]?.reason).toBe('Old cards crowd the board');
    expect((d.questions as Body[]).filter((q) => String(q.prompt).startsWith('Why is'))).toEqual(
      [],
    );
  });

  it('its answer becomes the revision’s reason once, even after the revision left draft', async () => {
    const { key } = await readyByMember('Cards carry a due date');
    const q = ((await detail(member, key)).questions as Body[]).find((x) =>
      String(x.prompt).startsWith('Why is'),
    );
    const answered = await api(member, 'POST', `/api/questions/${q?.id}/answer`, {
      round: q?.round,
      text: 'Nurses miss deadlines they cannot see',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(await deliver('question.answered', 'requirement-reason')).toBeGreaterThan(0);
    const d = await detail(member, key);
    const r1 = (d.revisions as Body[]).find((r) => r.revision === 1);
    expect(r1).toMatchObject({ state: 'current', reason: 'Nurses miss deadlines they cannot see' });
    // given once, it is frozen like every other field of a current revision
    await expect(
      db.execute(
        sql`UPDATE requirement_revisions SET reason = 'changed' WHERE requirement_id = ${String(d.id)} AND revision = 1`,
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/^REVISION_IMMUTABLE/) } });
  });
});

describe('the author is told at every step change (BC-21)', () => {
  it('tells the author Agreed, Deferred, Agreed again and In delivery, each with the step after it', async () => {
    const { key, id } = await readyByMember('Cards show their owner');
    const agreed = await on(member, 'POST', `/requirements/${key}/agree`, { revision: 1 });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    await deliver('requirement.transitioned', 'notify-requirements', id);
    const deferred = await on(admin, 'POST', `/requirements/${key}/defer`, {
      reason: 'Next quarter',
    });
    expect(deferred.status, JSON.stringify(deferred.body)).toBe(200);
    await deliver('requirement.transitioned', 'notify-requirements', id);
    const back = await on(admin, 'POST', `/requirements/${key}/undefer`, { reason: 'Pulled in' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    await deliver('requirement.transitioned', 'notify-requirements', id);
    // a linked issue leaving open starts its delivery: no stored move, the view reads In delivery
    const started = await createTestIssue(projectId, adminId, 1, {
      status: 'in_progress',
      createdAt: new Date(),
      requirementId: id,
    });
    const { consumerOf } = await import('../../src/outbox/consumers.js');
    await consumerOf('issue.transitioned', 'notify-requirement-step')?.handle(
      {
        entity: 'issue',
        id: started.id,
        projectId,
        issueId: started.id,
        from: 'open',
        to: 'in_progress',
        at: new Date().toISOString(),
      } as never,
      { eventId: randomUUID() } as never,
    );
    expect(await notices(memberId)).toEqual([
      { title: `${key} is Agreed: Cards show their owner`, body: 'Next: In delivery.' },
      { title: `${key} is Deferred: Cards show their owner`, body: 'Next: Agreed.' },
      { title: `${key} is Agreed: Cards show their owner`, body: 'Next: In delivery.' },
      { title: `${key} is In delivery: Cards show their owner`, body: 'Next: Delivered.' },
    ]);
    // nobody else is told, and a second read of the same step tells nobody again
    expect(await notices(adminId)).toEqual([]);
    await deliver('requirement.transitioned', 'notify-requirements', id);
    expect(await notices(memberId)).toHaveLength(4);
  });

  it('tells the author a drop, with nothing after it', async () => {
    const made = await on(member, 'POST', '/requirements', { title: 'Cards glow' });
    const id = String(made.body.id);
    const dropped = await on(admin, 'POST', `/requirements/${String(made.body.key)}/drop`, {
      reason: 'Nobody asked',
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
    await deliver('requirement.transitioned', 'notify-requirements', id);
    expect(await notices(memberId)).toEqual([
      { title: `${String(made.body.key)} is Dropped: Cards glow`, body: null },
    ]);
  });
});

describe('Needs you lists a gated step only for the member who must take it (BC-22)', () => {
  const asks = async (token: string, key: string) => {
    const r = await on(token, 'GET', '/needs-you');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Body[]).filter((i) => i.entity === 'requirement' && i.key === key);
  };

  /** Turns the project's person gates to `approvals`, through the project document's own write. */
  async function setApprovals(approvals: Record<string, boolean>): Promise<void> {
    const held = (await on(admin, 'GET', '/config')).body as {
      revision: number;
      document: Record<string, unknown>;
    };
    const put = await on(admin, 'PUT', '/config', {
      baseRevision: held.revision,
      document: { ...held.document, approvals },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }

  it('approvals.agree off: the owner who may agree it is asked, the admin who also may is not', async () => {
    const { key } = await readyByMember('Cards sort by date');
    expect(await asks(member, key)).toHaveLength(1);
    expect(await asks(admin, key)).toEqual([]);
  });

  it('approvals.agree on: only the admin holds requirements.approve, so only the admin is asked', async () => {
    await setApprovals({ agree: true });
    const { key } = await readyByMember('Cards sort by owner');
    expect(await asks(admin, key)).toHaveLength(1);
    expect(await asks(member, key)).toEqual([]);
  });
});
