import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';
process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';

import {
  bindTestRunner,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Body = Record<string, unknown>;

let harness: TestDatabase;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let claim: typeof import('../../src/devices/claim.js');
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let userId: string;
let projectId: string;
let person: string;
let deviceId: string;
let deviceToken: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
  claim = await import('../../src/devices/claim.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  person = await signUserToken(userId);
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: userId, name: 'claim-box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${deviceId}
  `);
  await bindTestRunner(harness.db, { projectId, deviceId });
});

async function issue(seq: number, status = 'open', extra: { plan?: string } = {}) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, plan,
                        acceptance_criteria)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId},
            CASE WHEN ${status} IN ('closed', 'awaiting_release') THEN now() END,
            ${extra.plan ?? null}, ${extra.plan ? '1. it holds' : null})
  `);
  return id;
}

async function blocks(from: string, to: string, validUntil: 'live' | 'retracted' = 'live') {
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
    VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, 'blocks',
            ${validUntil === 'retracted' ? sql`now() - interval '1 minute'` : sql`NULL`})
  `);
}

async function setStatus(id: string, status: string) {
  await harness.db.execute(sql`
    UPDATE issues SET status = ${status},
           merged_at = CASE WHEN ${status} IN ('closed', 'awaiting_release') THEN now() END
     WHERE id = ${id}
  `);
}

const lease = (holder: string, minutes = 30) => ({
  holder,
  renewedAt: new Date().toISOString(),
  minutes,
});

async function holdLease(id: string, holder = 'run-held') {
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(lease(holder))}::jsonb)
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease
  `);
}

async function leaseHolder(id: string): Promise<string | null> {
  const rows = (await harness.db.execute(sql`
    SELECT lease->>'holder' AS holder FROM issue_work_state WHERE issue_id = ${id}
  `)) as unknown as Array<{ holder: string | null }>;
  return rows[0]?.holder ?? null;
}

async function statusOf(id: string): Promise<string> {
  const rows = (await harness.db.execute(
    sql`SELECT status FROM issues WHERE id = ${id}`,
  )) as unknown as Array<{
    status: string;
  }>;
  return rows[0]?.status as string;
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Forge-Lifecycle': '10',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const codeOf = (r: { body: Body }) =>
  ((r.body.error as Body | undefined)?.code ?? r.body.code) as string | undefined;
const textOf = (r: { body: Body }) => JSON.stringify(r.body);

const claimLease = (id: string, holder: string, minutes = 30) =>
  call(person, 'PATCH', `/api/issues/${id}`, {
    sessionContext: { lease: lease(holder, minutes) },
  });

const toInProgress = (id: string) =>
  call(person, 'POST', `/api/issues/${id}/transition`, { toStatus: 'in_progress' });

describe('the move to in_progress', () => {
  it('refuses an open issue a live edge from an unstarted blocker holds, naming the blocker and its status', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    await blocks(blocker, held);
    await holdLease(held);

    const r = await toInProgress(held);

    expect(r.status, textOf(r)).toBe(409);
    expect(codeOf(r)).toBe('ISSUE_BLOCKED');
    expect(textOf(r)).toContain('ISS-1 is at `open`');
    expect(await statusOf(held)).toBe('open');
  });

  it('lets it through once the blocker reaches awaiting_release', async () => {
    const blocker = await issue(1, 'in_progress');
    const held = await issue(2, 'open');
    await blocks(blocker, held);
    await holdLease(held);
    expect((await toInProgress(held)).status).toBe(409);

    await setStatus(blocker, 'awaiting_release');

    const r = await toInProgress(held);
    expect(r.status, textOf(r)).toBe(200);
    expect(await statusOf(held)).toBe('in_progress');
  });

  it('refuses from reopen and approved too, and names a design revision a closed blocker still owes', async () => {
    const blocker = await issue(1, 'closed');
    const reopened = await issue(2, 'reopen');
    const approved = await issue(3, 'approved', { plan: 'build it' });
    await blocks(blocker, reopened);
    await blocks(blocker, approved);
    const wf = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document, design_status, written_by_user)
      VALUES (${wf}, ${projectId}, 'hop-access-decision', 'state', 'designed', 2, '{}'::jsonb, 'proposed', ${userId})
    `);
    await harness.db.execute(sql`
      INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, design_issue_id)
      VALUES (${wf}, 2, '{}'::jsonb, ${userId}, ${blocker})
    `);
    await holdLease(reopened);
    await holdLease(approved);

    for (const id of [reopened, approved]) {
      const r = await toInProgress(id);
      expect(r.status, textOf(r)).toBe(409);
      expect(codeOf(r)).toBe('ISSUE_BLOCKED');
      expect(textOf(r)).toContain('design hop-access-decision rev 2 is not approved');
    }
  });

  it('is not held by a retracted edge, nor by an edge of another kind', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    await blocks(blocker, held, 'retracted');
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${randomUUID()}, ${projectId}, ${blocker}, ${held}, 'relates')
    `);
    await holdLease(held);

    const r = await toInProgress(held);
    expect(r.status, textOf(r)).toBe(200);
  });
});

describe('a dropped blocker', () => {
  it('holds nothing, at a door and in the admissible set alike, even through an edge never expired', async () => {
    const blocker = await issue(1, 'dropped');
    const held = await issue(2, 'open');
    await blocks(blocker, held);

    const admitted = await call(
      deviceToken,
      'GET',
      `/api/devices/me/issues/admissible?projectId=${projectId}`,
    );
    const keys = ((admitted.body.items as Array<{ issueKey: string }>) ?? []).map(
      (i) => i.issueKey,
    );
    expect(keys).toEqual(['ISS-2']);
    const leased = await claimLease(held, 'run-free');
    expect(leased.status, textOf(leased)).toBe(200);
  });
});

describe('the lease a claim writes', () => {
  it('refuses a write that takes the lease of a blocked open issue, and writes nothing', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    await blocks(blocker, held);

    const r = await claimLease(held, 'run-a');

    expect(r.status, textOf(r)).toBe(409);
    expect(codeOf(r)).toBe('ISSUE_BLOCKED');
    expect(textOf(r)).toContain('ISS-2');
    expect(await leaseHolder(held)).toBeNull();
  });

  it('takes nothing on a renewal by the live holder, a hand-back, or an issue already in work', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    const working = await issue(3, 'in_progress');
    await blocks(blocker, held);
    await blocks(blocker, working);
    await holdLease(held, 'run-live');

    const renewal = await call(person, 'PATCH', `/api/issues/${held}`, {
      sessionContext: { lease: lease('run-live') },
      expect: { sessionContext: { lease: (await readComposed(held)).lease } },
    });
    expect(renewal.status, textOf(renewal)).toBe(200);

    const handBack = await call(person, 'PATCH', `/api/issues/${held}`, {
      sessionContext: { lease: { ...lease('run-live'), stopped: 'handed back' } },
      expect: { sessionContext: await readComposed(held) },
    });
    expect(handBack.status, textOf(handBack)).toBe(200);

    const inWork = await claimLease(working, 'run-b');
    expect(inWork.status, textOf(inWork)).toBe(200);
  });

  it('refuses a handoff to another holder while the edge stands, and allows it once retracted', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    await blocks(blocker, held);
    await holdLease(held, 'run-old');

    const r = await call(person, 'PATCH', `/api/issues/${held}`, {
      sessionContext: { lease: lease('run-new') },
      expect: { sessionContext: await readComposed(held) },
    });
    expect(codeOf(r), textOf(r)).toBe('ISSUE_BLOCKED');

    await harness.db.execute(sql`
      UPDATE issue_dependencies SET valid_until = now() - interval '1 second' WHERE to_issue_id = ${held}
    `);
    const after = await call(person, 'PATCH', `/api/issues/${held}`, {
      sessionContext: { lease: lease('run-new') },
      expect: { sessionContext: await readComposed(held) },
    });
    expect(after.status, textOf(after)).toBe(200);
    expect(await leaseHolder(held)).toBe('run-new');
  });

  it('refuses filing an issue at open with a blocks edge and a live lease in one write', async () => {
    const blocker = await issue(50, 'open');
    const { createIssue } = await import('../../src/issues/create-service.js');
    await expect(
      createIssue(
        {
          projectId,
          title: 'filed already claimed',
          status: 'open',
          sessionContext: { lease: lease('run-born') },
          relations: [{ kind: 'blocks', dependsOnId: blocker }],
        },
        {
          createdById: userId,
          createdByDeviceId: null,
          createdVia: 'mcp',
          actor: { type: 'user', id: userId, agency: 'agent' },
        },
      ),
    ).rejects.toMatchObject({ code: 'ISSUE_BLOCKED' });
    const rows = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM issues WHERE title = 'filed already claimed'`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });
});

async function readComposed(id: string): Promise<Body> {
  const rows = (await harness.db.execute(sql`
    SELECT issue_session_context(i.id, i.session_context) AS c FROM issues i WHERE i.id = ${id}
  `)) as unknown as Array<{ c: Body | null }>;
  return rows[0]?.c ?? {};
}

describe('the fleet key a run session takes', () => {
  it('refuses a group naming every blocked member, and takes no key', async () => {
    const blocker = await issue(1, 'open');
    await issue(2, 'open');
    const held3 = await issue(3, 'open');
    const held4 = await issue(4, 'reopen');
    await blocks(blocker, held3);
    await blocks(blocker, held4);

    const r = await call(deviceToken, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      issueKeys: ['ISS-2', 'ISS-3', 'ISS-4'],
      name: 'blocked-group',
      runId: randomUUID(),
    });

    expect(r.status, textOf(r)).toBe(409);
    expect(codeOf(r)).toBe('ISSUE_BLOCKED');
    expect(textOf(r)).toContain('ISS-3');
    expect(textOf(r)).toContain('ISS-4');
    expect(textOf(r)).not.toContain('ISS-2:');
    const keys = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM issue_leases WHERE project_id = ${projectId}`,
    )) as unknown as Array<{ n: number }>;
    expect(keys[0]?.n).toBe(0);
  });

  it('opens over the same issues once the blocker is closed', async () => {
    const blocker = await issue(1, 'open');
    await issue(3, 'open');
    await blocks(blocker, (await idOf(3)) as string);
    await setStatus(blocker, 'closed');

    const r = await call(deviceToken, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      issueKeys: ['ISS-3'],
      name: 'released-group',
      runId: randomUUID(),
    });
    expect(r.status, textOf(r)).toBe(200);
  });
});

async function idOf(seq: number): Promise<string | undefined> {
  const rows = (await harness.db.execute(
    sql`SELECT id FROM issues WHERE project_id = ${projectId} AND iss_seq = ${seq}`,
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id;
}

describe('the pool prepare', () => {
  async function job(issueId: string): Promise<string> {
    const run = randomUUID();
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${run}, ${projectId}, ${issueId}, 'issue', 'running')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at, payload)
      VALUES (${id}, ${projectId}, ${issueId}, ${run}, 'code', 'queued', ${userId},
              now() - interval '5 minutes', '{"promptString":"do the step"}'::jsonb)
    `);
    return id;
  }

  it('refuses a job on a blocked issue in the policy-refusal shape the box reads, and leaves it queued', async () => {
    const blocker = await issue(1, 'open');
    const held = await issue(2, 'open');
    await blocks(blocker, held);
    const jobId = await job(held);

    const result = await claim.prepareJobForMaster({ jobId, deviceId, sessionId: randomUUID() });

    expect(result).toMatchObject({ ok: false, reason: 'policy_refused', code: 'ISSUE_BLOCKED' });
    expect((result as { detail: string }).detail).toContain('ISS-1 is at `open`');
    const rows = (await harness.db.execute(
      sql`SELECT status, held_by FROM jobs WHERE id = ${jobId}`,
    )) as unknown as Array<{ status: string; held_by: string | null }>;
    expect(rows[0]).toEqual({ status: 'queued', held_by: null });
  });

  it('holds the job once the blocker settles', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2, 'open');
    await blocks(blocker, held);
    const jobId = await job(held);

    const result = await claim.prepareJobForMaster({ jobId, deviceId, sessionId: randomUUID() });
    expect(result).not.toMatchObject({ code: 'ISSUE_BLOCKED' });
  });
});

describe("the admissible set's other holds at the doors that did not ask them", () => {
  it('refuses the lease and the move to in_progress for an issue building a workflow whose design is not approved', async () => {
    const building = await issue(2, 'open');
    const wf = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document, design_status, written_by_user)
      VALUES (${wf}, ${projectId}, 'post-discharge', 'flow', 'designed', 1, '{}'::jsonb, 'proposed', ${userId})
    `);
    await harness.db.execute(sql`
      INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
      VALUES (${building}, ${wf}, ${projectId}, ${userId})
    `);

    const leased = await claimLease(building, 'run-design');
    expect(leased.status, textOf(leased)).toBe(409);
    expect(codeOf(leased)).toBe('WORKFLOW_DESIGN_NOT_APPROVED');

    await holdLease(building);
    const moved = await toInProgress(building);
    expect(moved.status, textOf(moved)).toBe(409);
    expect(codeOf(moved)).toBe('WORKFLOW_DESIGN_NOT_APPROVED');
  });
});

describe('one predicate', () => {
  it('admits exactly what the doors let through', async () => {
    const blocker = await issue(1, 'in_progress');
    await issue(2, 'open');
    const held = await issue(3, 'open');
    await blocks(blocker, held);

    const admitted = await call(
      deviceToken,
      'GET',
      `/api/devices/me/issues/admissible?projectId=${projectId}`,
    );
    const keys = ((admitted.body.items as Array<{ issueKey: string }>) ?? []).map(
      (i) => i.issueKey,
    );
    expect(keys).toEqual(['ISS-2']);
    expect(codeOf(await claimLease(held, 'run-x'))).toBe('ISSUE_BLOCKED');
  });
});
