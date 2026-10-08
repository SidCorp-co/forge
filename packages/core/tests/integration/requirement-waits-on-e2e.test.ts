import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { peopleOf } from '../../src/lib/people.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { ago, issue, requirement, type World, world } from '../helpers/forecast-world.js';
import { seedProductionDeployTrigger } from '../helpers/release-world.js';

// ISS-461 round 3 (REQ-35 BC-5): a requirement's standing names whom it actually waits on, read
// through the requirement route a page reads: the person owing the release cut once every issue has
// landed, the release linked; what a parked issue waits on, the issue linked; its issues only while
// one is worked. The page's strip reads nothing else.

/** An agreed requirement at r1 with an owner, moved inside the kernel's own transaction, so the turn reaches its issues. */
async function agreed(w: World, title: string): Promise<{ id: string; key: string }> {
  const r = await requirement(w, title);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${r.id}, 1, 'current', ${JSON.stringify({ goal: title })}::jsonb, 'seed', ${w.userId}, 'human', ${w.userId}, now())
    `);
    await tx.execute(sql`
      UPDATE requirements SET status = 'agreed', current_revision = 1, owner_id = ${w.userId}
       WHERE id = ${r.id}`);
  });
  return r;
}

async function waitOf(w: World, token: string, key: string): Promise<Body> {
  const res = await api(token, 'GET', `/api/projects/${w.projectId}/requirements/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.standing as Body).waitingOn as Body;
}

describe('whom a requirement waits on once its issues exist', () => {
  let w: World;
  let memberToken = '';
  let adminName = '';
  const req = { landed: '', parked: '', running: '', queued: '' };
  let parkedKey = '';

  beforeAll(async () => {
    w = await world();
    // a person cuts each release: the admin holds project.admin
    await seedProductionDeployTrigger(w.projectId, w.userId, 'on-request');
    const member = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, member.id, 'member');
    memberToken = await userToken(member.id);
    adminName = (await peopleOf([w.userId])).get(w.userId)?.name ?? '';

    const landed = await agreed(w, 'The board loads fast');
    for (const at of [5, 4]) {
      await issue(w, {
        status: 'awaiting_release',
        createdAt: ago(at),
        mergedAt: ago(at - 1),
        requirementId: landed.id,
      });
    }
    await issue(w, {
      status: 'closed',
      createdAt: ago(9),
      mergedAt: ago(8),
      requirementId: landed.id,
    });
    req.landed = landed.key;

    const parked = await agreed(w, 'The board exports its cards');
    parkedKey = (
      await issue(w, {
        status: 'needs_info',
        waitingKind: 'needs_decision',
        createdAt: ago(3),
        requirementId: parked.id,
      })
    ).key;
    await issue(w, { status: 'in_progress', createdAt: ago(2), requirementId: parked.id });
    req.parked = parked.key;

    const running = await agreed(w, 'The board keeps its cards');
    await issue(w, { status: 'in_progress', createdAt: ago(2), requirementId: running.id });
    await issue(w, {
      status: 'awaiting_release',
      createdAt: ago(3),
      mergedAt: ago(1),
      requirementId: running.id,
    });
    req.running = running.key;

    const queued = await agreed(w, 'The board prints its cards');
    await issue(w, { status: 'open', createdAt: ago(2), requirementId: queued.id });
    await issue(w, {
      status: 'awaiting_release',
      createdAt: ago(3),
      mergedAt: ago(1),
      requirementId: queued.id,
    });
    req.queued = queued.key;
  }, 120_000);

  it('names the admin who owes the cut, and the version, once every issue not shipped has landed', async () => {
    const asMember = await waitOf(w, memberToken, req.landed);
    expect(asMember).toMatchObject({ kind: 'person', who: adminName, refers: 'release' });
    expect(asMember.act).toMatch(/^cut \d+\.\d+\.\d+/);
    expect(asMember.ref).toBe((asMember.act as string).replace(/^cut /, ''));
    expect(asMember.who).not.toBe('Issues');
    // the admin reading it is the one who cuts
    expect(await waitOf(w, w.token, req.landed)).toMatchObject({
      kind: 'you',
      who: 'You',
      refers: 'release',
    });
  });

  it('names what a parked issue waits on, its key linked, while another issue runs', async () => {
    const wait = await waitOf(w, memberToken, req.parked);
    expect(wait).toMatchObject({
      refers: 'issue',
      ref: parkedKey,
      act: `make a decision on ${parkedKey}`,
    });
    expect(wait.who).not.toBe('Issues');
  });

  it('says its issues only while one of them is worked', async () => {
    expect(await waitOf(w, memberToken, req.running)).toMatchObject({
      kind: 'issue',
      who: 'Issues',
      act: 'Running 1 of 2',
    });
  });

  it('waits on the master to take a queued issue, never on its issues', async () => {
    const wait = await waitOf(w, memberToken, req.queued);
    expect(wait).toMatchObject({ kind: 'agent', who: 'Master' });
    expect(wait.act).toMatch(/^take [A-Z]+-\d+ next$/);
  });
});
