/**
 * A person's ruling for a production act (REQ-80 BC-11, BC-12), against real Postgres: a run working
 * an open issue on which a project admin recorded a `decision` naming the act and a production-tier
 * environment (`production`) reads that environment's protected variables through the variables run
 * door, each read audited naming the ruling, the issue and the run, the value scrubbed and the
 * variable left protected. Every other run is refused naming the ruling it lacks and who gives it:
 * none written, a member's or an agent's, another environment, a closed or dropped issue, another
 * issue's, a withdrawn one; and no refusal tells it to have protection turned off.
 *
 * @direct-test-of packages/core/src/project-config/variables-run-door.ts
 * @direct-test-of packages/core/src/issues/record-events/production-rulings.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { agentSessionsPorts } from '../../src/agent-sessions/ports.js';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor, workspaceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const STRIPE = 'sk_live_protected_Pr0duction_key';

const world = {
  ownerId: '',
  memberId: '',
  projectId: '',
  box: '',
  boxToken: '',
  /** The box's credential bound to this project: an agent's, as a master's pane holds it. */
  agent: '',
  owner: '',
  member: '',
};

const codeOf = (body: unknown): string | undefined => {
  const b = body as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code;
};

async function ok<T = Record<string, unknown>>(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as T;
}

const add = (token: string, body: Record<string, unknown>) =>
  api(token, 'POST', `/api/projects/${world.projectId}/variables`, {
    environment: null,
    type: 'secret',
    protected: false,
    ...body,
  });

/** A run the box's master declared over ISS-`seq`; answers the id the box declared it under. */
async function declaredRun(seq: number): Promise<{ boxRunId: string; session: string }> {
  const boxRunId = randomUUID();
  const runId = randomUUID();
  const key = `ISS-${seq}`;
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: 'in_progress' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${world.projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${world.projectId}, ${world.box}, ${runId}, 'run_session', 'running', now(), now())
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  return { boxRunId, session: s.id };
}

const runVariables = (run: string, environment: string, keys: string[] = []) =>
  api(
    world.boxToken,
    'GET',
    `/api/jobs/${run}/variables/${environment}${keys.length ? `?${keys.map((k) => `key=${k}`).join('&')}` : ''}`,
  );

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.memberId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  await addProjectMember(world.projectId, world.memberId, 'member');
  world.owner = await userToken(world.ownerId);
  world.member = await userToken(world.memberId);
  world.box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  const pat = async (name: string, projectIds: string[], onBehalfOf?: string) =>
    (
      await mintPat({
        userId: world.ownerId,
        name,
        scopes: ['read', 'write'],
        permissions: ['*'],
        projectIds,
        ...(onBehalfOf ? { onBehalfOf } : {}),
        deviceId: world.box,
      })
    ).plaintext;
  world.boxToken = await pat(deviceTokenNameFor(world.box), [], world.ownerId);
  world.agent = await pat(workspaceTokenNameFor(world.box, world.projectId), [world.projectId]);
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    environments: {
      stg: { tier: 'staging', deploysFrom: 'release/stg', deployment: { mode: 'external' } },
      production: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
  });
});

describe("a person's ruling for a production act opens its protected variables (BC-11, BC-12)", () => {
  const ACT = 'Set supplier PGPrints on production';
  let issueId = '';

  beforeEach(async () => {
    await ok(
      add(world.owner, {
        key: 'STRIPE_KEY',
        value: STRIPE,
        environment: 'production',
        protected: true,
      }),
    );
    issueId = (
      await createTestIssue(world.projectId, world.ownerId, 40, {
        status: 'in_progress',
        createdAt: new Date(),
      })
    ).id;
  });

  const rule = (token: string, environment = 'production', on = issueId) =>
    api(token, 'POST', `/api/issues/${on}/events`, {
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'decision', value: ACT },
        { key: 'production', value: environment },
      ],
    });

  /** The refusal a run gets for STRIPE_KEY, checked to name the ruling and who gives it. */
  async function refusedFor(run: string): Promise<string> {
    const res = await runVariables(run, 'production', ['STRIPE_KEY']);
    expect([res.status, codeOf(res.body)]).toEqual([403, 'VARIABLE_PROTECTED_WITHHELD']);
    const said = JSON.stringify(res.body);
    expect(said).not.toContain(STRIPE);
    expect(said).toContain('a person holding project.admin on this project');
    expect(said).toContain('once, in plain words');
    expect(said).not.toMatch(/protection off|protected: false|turn[^.]*protection/i);
    return said;
  }

  it('gives a run working the ruled issue the protected value, audited and scrubbed, protection kept on', async () => {
    const ruling = await ok<{ id: string }>(rule(world.owner));
    const run = await declaredRun(40);
    const res = await runVariables(run.boxRunId, 'production', ['STRIPE_KEY']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ variables: [{ key: 'STRIPE_KEY', value: STRIPE }] });

    const audit = await rows<{ key: string; detail: Record<string, unknown> }>(
      sql`SELECT key, detail FROM project_variable_events WHERE act = 'delivered'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({
      ruling: { id: ruling.id, issue: 'ISS-40', issueId, by: world.ownerId },
      run: { kind: 'run', session: run.session },
    });
    expect(JSON.stringify(audit)).not.toContain(STRIPE);
    const posted = await agentSessionsPorts().scrubSessionOutput(run.session, {
      line: `admin key ${STRIPE}`,
    });
    expect(JSON.stringify(posted)).not.toContain(STRIPE);
    const kept = await rows<{ protected: boolean }>(
      sql`SELECT protected FROM project_variables WHERE key = 'STRIPE_KEY'`,
    );
    expect(kept).toEqual([{ protected: true }]);
  });

  it('withholds it where no ruling is written, naming the issue it read', async () => {
    const run = await declaredRun(40);
    expect(await refusedFor(run.boxRunId)).toContain(
      "none of this run's issues (ISS-40) carries a ruling for a production act on `production`",
    );
    const listed = await runVariables(run.boxRunId, 'production');
    expect(listed.body).toMatchObject({ variables: [], withheld: ['STRIPE_KEY'] });
  });

  it('withholds it where the ruling is written by a member without project.admin', async () => {
    await ok(rule(world.member));
    const run = await declaredRun(40);
    expect(await refusedFor(run.boxRunId)).toContain('who holds no project.admin');
  });

  it("withholds it where the ruling is written by an agent on an admin's account", async () => {
    await ok(rule(world.agent));
    const run = await declaredRun(40);
    expect(await refusedFor(run.boxRunId)).toContain(
      "written by an agent, and a ruling is a person's",
    );
  });

  it('withholds it where the ruling names another environment', async () => {
    await ok(rule(world.owner, 'stg'));
    const run = await declaredRun(40);
    expect(await refusedFor(run.boxRunId)).toContain(
      "ISS-40's ruling names `stg`, not `production`",
    );
  });

  it('withholds it once the ruled issue is closed or dropped', async () => {
    for (const [seq, status] of [
      [42, 'closed'],
      [43, 'dropped'],
    ] as const) {
      const { id } = await createTestIssue(world.projectId, world.ownerId, seq, {
        status,
        createdAt: new Date(),
        mergedAt: new Date(),
      });
      await ok(rule(world.owner, 'production', id));
      const run = await declaredRun(seq);
      expect(await refusedFor(run.boxRunId)).toContain(
        `ISS-${seq} is ${status}, and a ruling holds only while its issue is open`,
      );
    }
  });

  it('withholds it from a run working another issue, naming the ruled one', async () => {
    await ok(rule(world.owner));
    await createTestIssue(world.projectId, world.ownerId, 41, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const other = await declaredRun(41);
    expect(await refusedFor(other.boxRunId)).toContain(
      'ISS-40 carries a ruling for `production`, and this run works ISS-41, not ISS-40',
    );
  });

  it('withholds it once the ruling is withdrawn', async () => {
    const ruling = await ok<{ id: string }>(rule(world.owner));
    await ok(
      api(world.owner, 'POST', `/api/issues/${issueId}/events/${ruling.id}/withdraw`, {
        reason: 'The supplier is set by hand instead.',
      }),
    );
    const run = await declaredRun(40);
    expect(await refusedFor(run.boxRunId)).toContain("none of this run's issues (ISS-40)");
  });
});
