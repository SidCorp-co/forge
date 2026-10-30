/**
 * A person holding project admin declares a review run over one issue on one box, and a session
 * working for that person on the box reads the named testing profile at the one value door under
 * the box's credential (forge-core-61, 2026-10-30: the owner's own review session, and agenfold, which
 * has no master, had no route to a testing identity and fell back to local credential files). The
 * run is the declared run a master's `run declare` opens, declared by a person: it takes no issue,
 * reads the profile its declaration names, ends at the time it names, and closes through the box's
 * close door. Refused by name: a caller without project admin, an agent, an issue of another project,
 * an unknown profile, a box outside the project's organisation, a box not serving the project, and
 * reads after the run is closed or past its end. Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/review-run-routes.ts
 * @direct-test-of packages/core/src/project-config/review-run.ts
 * @direct-test-of packages/core/src/devices/review-run.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 * @direct-test-of packages/core/src/project-config/review-run-secrets.ts
 * @direct-test-of packages/core/src/project-config/testing-secret-values.ts
 * @direct-test-of packages/core/src/devices/declared-run-of-call.ts
 * @direct-test-of packages/core/src/devices/run-session-reaper.ts
 * @direct-test-of packages/core/src/pipeline/one-shot-reap.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { workspaceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { reapDeadRunSessions } from '../../src/devices/index.js';
import { reapOrphanedOneShotRuns } from '../../src/pipeline/index.js';
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

const MEMBER = 'member@forge-dev.test:Corr3ct-H0rse-Battery';
const OWNER = 'owner@forge-dev.test:Tr0ub4dor-and-3';
const MEMBER_REF = 'secret://dev/qa';
const OWNER_REF = 'secret://dev/orchestrator';

const world = {
  adminId: '',
  orgId: '',
  projectId: '',
  slug: '',
  box: '',
  boxName: '',
  boxToken: '',
  issueId: '',
};

async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** The forge `dev` profile on dev core: two actors, each behind a secret. */
async function devProfile(projectId: string): Promise<void> {
  const token = await userToken(world.adminId);
  await ok(api(token, 'PUT', `/api/projects/${projectId}/secrets/dev/qa`, { value: MEMBER }));
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/secrets/dev/orchestrator`, { value: OWNER }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/testing-profiles/dev`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'dev',
        actors: {
          owner: { role: 'org-owner', credential: OWNER_REF },
          member: { role: 'project-member', credential: MEMBER_REF },
        },
        services: {},
        limits: [],
      },
    }),
  );
}

const declare = (token: string, body: Record<string, unknown>, projectId = world.projectId) =>
  api(token, 'POST', `/api/projects/${projectId}/review-runs`, body);

const secrets = (token: string, id: string, profile = 'dev') =>
  api(token, 'GET', `/api/jobs/${id}/testing-profiles/${profile}/secrets`);

const codeOf = (body: unknown): string | undefined => {
  const b = body as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code;
};

interface Declared {
  runId: string;
  sessionId: string;
  issue: string;
  box: { id: string; name: string };
  profile: string;
  declaredBy: string;
  expiresAt: string;
  read: string;
  close: string;
  says: string;
}

async function declared(body: Record<string, unknown> = {}): Promise<Declared> {
  const token = await userToken(world.adminId);
  const res = await declare(token, { issue: 'ISS-7', box: world.boxName, profile: 'dev', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as unknown as Declared;
}

beforeEach(async () => {
  await truncateAll();
  world.adminId = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(world.adminId);
  world.projectId = project.id;
  world.slug = project.slug;
  world.orgId = project.orgId;
  await addProjectMember(world.projectId, world.adminId, 'admin');
  world.boxName = `sid-xeon-${randomUUID().slice(0, 6)}`;
  world.box = await createTestDevice(world.adminId, { name: world.boxName });
  await bindTestRunner(world.projectId, world.box);
  // the checkout credential a pane on the box borrows (`FORGE_BORROW_FROM`): it carries the box
  world.boxToken = (
    await mintPat({
      userId: world.adminId,
      name: workspaceTokenNameFor(world.box, world.projectId),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [world.projectId],
      deviceId: world.box,
    })
  ).plaintext;
  await devProfile(world.projectId);
  // as forge on dev core: two environments deploy `dev`, and an issue still being worked has not landed
  await seedProjectDocument(world.projectId, world.adminId, {
    defaultBranch: 'main',
    promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
    environments: {
      dev: {
        tier: 'production',
        deploysFrom: 'dev',
        deployment: { mode: 'external' },
        testing: 'dev',
      },
      demo: { tier: 'preview', deploysFrom: 'dev', deployment: { mode: 'external' } },
    },
  });
  world.issueId = (
    await createTestIssue(world.projectId, world.adminId, 7, {
      status: 'in_progress',
      createdAt: new Date(),
    })
  ).id;
});

describe('a person-declared review run reads the testing profile it names under the box credential', () => {
  it('is refused with no run declared, and answers once a review run is declared through the door', async () => {
    // planted: the box credential alone, naming no run core holds, reads nothing
    const before = await secrets(world.boxToken, randomUUID());
    expect(before.status, JSON.stringify(before.body)).toBe(409);
    expect(codeOf(before.body)).toBe('TESTING_SECRETS_RUN_NOT_RECORDED');

    const run = await declared();
    expect(run).toMatchObject({
      issue: 'ISS-7',
      box: { id: world.box, name: world.boxName },
      profile: 'dev',
      declaredBy: world.adminId,
      read: `forge-runner api jobs/${run.runId}/testing-profiles/dev/secrets`,
      close: `forge-runner api -X POST devices/me/run-sessions/${run.sessionId}/close -f outcome=ended`,
    });
    expect(run.says).toContain(`master/${world.slug}/forge-cli.json`);
    const life = Date.parse(run.expiresAt) - Date.now();
    expect(life).toBeGreaterThan(29 * 60_000);
    expect(life).toBeLessThanOrEqual(30 * 60_000);

    const res = await secrets(world.boxToken, run.runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      run: { session: string; id: string };
      environment: string | null;
      secrets: Array<{ ref: string; value: string }>;
    };
    expect(body.run).toEqual({ session: run.sessionId, id: run.runId });
    // the one environment naming `dev`, though two deploy the branch and the issue has not landed
    expect(body.environment).toBe('dev');
    expect(body.secrets.map((s) => s.ref).sort()).toEqual([OWNER_REF, MEMBER_REF].sort());
    expect(body.secrets.map((s) => s.value.length).sort()).toEqual(
      [OWNER.length, MEMBER.length].sort(),
    );
  });

  it('records who declared it, for which issue, on which box and profile, and audits each read naming the declarer', async () => {
    const run = await declared();
    const [session] = await rows<{
      user_id: string;
      device_id: string;
      kind: string;
      status: string;
      parent_session_id: string | null;
      metadata: Record<string, unknown>;
    }>(sql`
      SELECT s.user_id, s.device_id, s.kind, s.status, s.parent_session_id, r.metadata
        FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE s.id = ${run.sessionId} AND r.id = ${run.runId}`);
    expect(session).toMatchObject({
      user_id: world.adminId,
      device_id: world.box,
      kind: 'run_session',
      status: 'running',
      parent_session_id: null,
    });
    expect(session?.metadata).toMatchObject({
      runGroup: ['ISS-7'],
      runIssues: [],
      role: 'review',
      reviewRun: { declaredBy: world.adminId, profile: 'dev', expiresAt: run.expiresAt },
    });
    // a review reads; it holds no lease on the issue it reviews
    const leases = await rows(
      sql`SELECT 1 FROM issue_leases WHERE project_id = ${world.projectId} AND issue_key = 'ISS-7'`,
    );
    expect(leases).toHaveLength(0);

    expect((await secrets(world.boxToken, run.runId)).status).toBe(200);
    const activity = await rows<{
      action: string;
      actor_id: string;
      payload: Record<string, unknown>;
    }>(
      sql`SELECT action, actor_id, payload FROM activity_log WHERE issue_id = ${world.issueId} ORDER BY created_at`,
    );
    expect(activity.map((a) => a.action)).toEqual([
      'review_run.declared',
      'testing_secrets.resolved',
    ]);
    expect(activity[0]).toMatchObject({
      actor_id: world.adminId,
      payload: { sessionId: run.sessionId, runId: run.runId, deviceId: world.box, profile: 'dev' },
    });
    expect(activity[1]?.payload).toMatchObject({
      sessionId: run.sessionId,
      declaredBy: world.adminId,
      profile: 'dev',
      environment: 'dev',
    });
    expect(JSON.stringify(activity)).not.toContain(MEMBER);
    expect(JSON.stringify(activity)).not.toContain(OWNER);
  });

  it('answers a project no environment of which names the profile, as agenfold, naming no environment', async () => {
    await db.execute(
      sql`DELETE FROM project_config_documents WHERE project_id = ${world.projectId}`,
    );
    const run = await declared({ issue: world.issueId, box: world.box, minutes: 5 });
    expect(Date.parse(run.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const res = await secrets(world.boxToken, run.runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { environment: unknown }).environment).toBeNull();
  });

  it('serves only the profile it was declared for', async () => {
    const token = await userToken(world.adminId);
    await ok(
      api(token, 'PUT', `/api/projects/${world.projectId}/testing-profiles/other`, {
        baseRevision: null,
        document: {
          $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
          version: 1,
          id: 'other',
          actors: { member: { role: 'project-member', credential: MEMBER_REF } },
          services: {},
          limits: [],
        },
      }),
    );
    const run = await declared();
    const res = await secrets(world.boxToken, run.runId, 'other');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_PROFILE_NOT_NAMED');
    expect(JSON.stringify(res.body)).toContain('declared to read testing profile `dev`');
  });
});

describe('the declaration is refused by name', () => {
  it('refuses a caller holding only member on the project', async () => {
    const member = (await createTestUser({ verified: true })).id;
    await addProjectMember(world.projectId, member, 'member');
    const res = await declare(await userToken(member), {
      issue: 'ISS-7',
      box: world.boxName,
      profile: 'dev',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('PERMISSION_FORBIDDEN');
    expect(JSON.stringify(res.body)).toContain('project.admin');
    expect(await rows(sql`SELECT 1 FROM agent_sessions WHERE kind = 'run_session'`)).toHaveLength(
      0,
    );
  });

  it('refuses an agent account, whose runs its master declares', async () => {
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(world.projectId, agent, 'admin');
    const res = await declare(await userToken(agent), {
      issue: 'ISS-7',
      box: world.boxName,
      profile: 'dev',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('REVIEW_RUN_NOT_A_PERSON');
  });

  it("refuses an issue of another project, by id and by another project's key", async () => {
    const other = await createTestProject(world.adminId, { orgId: world.orgId });
    await addProjectMember(other.id, world.adminId, 'admin');
    const foreign = await createTestIssue(other.id, world.adminId, 3, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const token = await userToken(world.adminId);
    for (const issue of [foreign.id, 'ISS-3', 'XYZ-7']) {
      const res = await declare(token, { issue, box: world.boxName, profile: 'dev' });
      expect(res.status, `${issue}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(codeOf(res.body), issue).toBe('REVIEW_RUN_ISSUE_NOT_IN_PROJECT');
    }
    expect(await rows(sql`SELECT 1 FROM agent_sessions WHERE kind = 'run_session'`)).toHaveLength(
      0,
    );
  });

  it('refuses a profile the project does not declare', async () => {
    const res = await declare(await userToken(world.adminId), {
      issue: 'ISS-7',
      box: world.boxName,
      profile: 'stg',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('REVIEW_RUN_PROFILE_UNKNOWN');
  });

  it('refuses a box paired to no project of the organisation, and one that does not serve this project', async () => {
    const token = await userToken(world.adminId);
    const stranger = await createTestDevice(world.adminId, { name: 'elsewhere' });
    const elsewhere = await createTestProject(world.adminId);
    await bindTestRunner(elsewhere.id, stranger);
    for (const box of [stranger, 'elsewhere', 'no-such-box']) {
      const res = await declare(token, { issue: 'ISS-7', box, profile: 'dev' });
      expect(res.status, `${box}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(codeOf(res.body), box).toBe('REVIEW_RUN_BOX_NOT_IN_ORG');
    }
    // in the organisation, serving another of its projects and not this one
    const sibling = await createTestProject(world.adminId, { orgId: world.orgId });
    const neighbour = await createTestDevice(world.adminId);
    await bindTestRunner(sibling.id, neighbour);
    const res = await declare(token, { issue: 'ISS-7', box: neighbour, profile: 'dev' });
    expect(codeOf(res.body), JSON.stringify(res.body)).toBe('RUNNER_NOT_ADMITTED');
  });
});

describe('a review run ends through the close door or at its declared end', () => {
  it('reads nothing once closed at the box close door under the same credential', async () => {
    const run = await declared();
    const closed = await api(
      world.boxToken,
      'POST',
      `/api/devices/me/run-sessions/${run.sessionId}/close`,
      { outcome: 'ended' },
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const res = await secrets(world.boxToken, run.runId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_RUN_ENDED');
    const [run_] = await rows<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${run.runId}`,
    );
    expect(run_?.status).toBe('completed');
  });

  it('reads nothing past its end, and the run-session reaper ends it there', async () => {
    const run = await declared();
    await db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = jsonb_set(metadata, '{reviewRun,expiresAt}', to_jsonb((now() - interval '1 second')::text))
       WHERE id = ${run.runId}`);
    const res = await secrets(world.boxToken, run.runId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_RUN_ENDED');
    expect(JSON.stringify(res.body)).toContain('review run a person declared');

    const reaped = await reapDeadRunSessions();
    expect(reaped.map((r) => r.sessionId)).toContain(run.sessionId);
    const [after] = await rows<{ session: string; run: string }>(sql`
      SELECT s.status AS session, r.status AS run
        FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE s.id = ${run.sessionId}`);
    expect(after).toEqual({ session: 'completed', run: 'completed' });
  });

  it('is not failed for silence before its end, which no box process beats', async () => {
    const run = await declared({ minutes: 120 });
    // twenty minutes on: past the box-silence reap and the one-shot reap of a beaten run session
    await db.execute(sql`
      UPDATE agent_sessions
         SET last_heartbeat_at = now() - interval '20 minutes',
             started_at = now() - interval '20 minutes',
             created_at = now() - interval '20 minutes',
             updated_at = now() - interval '20 minutes'
       WHERE id = ${run.sessionId}`);
    await db.execute(sql`
      UPDATE pipeline_runs SET started_at = now() - interval '20 minutes' WHERE id = ${run.runId}`);
    await reapDeadRunSessions();
    await reapOrphanedOneShotRuns(new Date());
    const [still] = await rows<{ session: string; run: string }>(sql`
      SELECT s.status AS session, r.status AS run
        FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE s.id = ${run.sessionId}`);
    expect(still).toEqual({ session: 'running', run: 'running' });
    expect((await secrets(world.boxToken, run.runId)).status).toBe(200);
  });
});
