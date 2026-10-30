/**
 * A project's environment variables (REQ-80 r3, design `environment-variables` r3), against real
 * Postgres: a holder of env.manage adds, edits, deletes and reveals them, everyone else reads names
 * (BC-1, BC-2); each act is audited by fingerprint and never by value (BC-2); an agent credential
 * proposes and a person decides (BC-6); a testing profile names a stored variable rather than a copy
 * (BC-7); and a declared run receives the effective variables of the environment it targets, a
 * protected one only where that environment is production-tier and its work landed there, an unknown
 * key refused by name (BC-8).
 *
 * @direct-test-of packages/core/src/project-config/variables-service.ts
 * @direct-test-of packages/core/src/project-config/variables-proposals.ts
 * @direct-test-of packages/core/src/project-config/variables-run-door.ts
 * @direct-test-of packages/core/src/project-config/testing-secret-values.ts
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

const STG_DB = 'postgres://stg-user:Stg-Pa55word@db.stg.internal/app';
const ALL_DB = 'postgres://all-user:All-Pa55word@db.internal/app';
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

const base = () => `/api/projects/${world.projectId}/variables`;

interface Listed {
  variables: {
    id: string;
    key: string;
    environment: string | null;
    type: string;
    value: string | null;
    fingerprint: string;
    version: number;
  }[];
  canManage: boolean;
}

function add(token: string, body: Record<string, unknown>) {
  return api(token, 'POST', base(), {
    environment: null,
    type: 'secret',
    protected: false,
    ...body,
  });
}

/** ISS-`seq`, landed on `target`. */
async function landedIssue(seq: number, target: string): Promise<string> {
  const { id } = await createTestIssue(world.projectId, world.ownerId, seq, {
    status: 'awaiting_release',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await db.execute(sql`UPDATE issues SET merged_target = ${target} WHERE id = ${id}`);
  return id;
}

/** A run the box's master declared over ISS-`seq`; answers the id the box declared it under. */
async function declaredRun(seq: number): Promise<{ boxRunId: string; session: string }> {
  const boxRunId = randomUUID();
  const runId = randomUUID();
  const key = `ISS-${seq}`;
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: 'awaiting_release' },
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
  world.boxToken = (
    await mintPat({
      userId: world.ownerId,
      name: deviceTokenNameFor(world.box),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [],
      onBehalfOf: world.ownerId,
      deviceId: world.box,
    })
  ).plaintext;
  world.agent = (
    await mintPat({
      userId: world.ownerId,
      name: workspaceTokenNameFor(world.box, world.projectId),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [world.projectId],
      deviceId: world.box,
    })
  ).plaintext;
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        testing: 'stg',
      },
      production: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
  });
});

describe('a holder of env.manage holds the variables; everyone else reads names (BC-1, BC-2)', () => {
  it('adds, lists with secrets masked, reveals on request and audits every act without a value', async () => {
    await ok(add(world.owner, { key: 'DATABASE_URL', value: STG_DB, environment: 'stg' }));
    await ok(add(world.owner, { key: 'LOG_LEVEL', value: 'debug', type: 'plain' }));
    const listed = await ok<Listed>(api(world.owner, 'GET', base()));
    expect(listed.canManage).toBe(true);
    const secret = listed.variables.find((v) => v.key === 'DATABASE_URL');
    expect(secret).toMatchObject({ environment: 'stg', type: 'secret', value: null });
    expect(listed.variables.find((v) => v.key === 'LOG_LEVEL')?.value).toBe('debug');
    expect(JSON.stringify(listed)).not.toContain(STG_DB);

    const revealed = await ok<{ value: string }>(
      api(world.owner, 'POST', `${base()}/${secret?.id}/reveal`),
    );
    expect(revealed.value).toBe(STG_DB);

    const { events } = await ok<{ events: { act: string; newFingerprint: string | null }[] }>(
      api(world.owner, 'GET', `${base()}/events`),
    );
    expect(events.map((e) => e.act).sort()).toEqual(['created', 'created', 'revealed']);
    expect(
      events.every((e) => e.newFingerprint === secret?.fingerprint || e.act === 'created'),
    ).toBe(true);
    const stored = await rows<Record<string, unknown>>(sql`SELECT * FROM project_variable_events`);
    expect(JSON.stringify(stored)).not.toContain(STG_DB);
    expect(JSON.stringify(stored)).not.toContain('debug');
  });

  it('gives a member names and fingerprints, never a value, and refuses its writes and reveals by permission', async () => {
    const created = await ok<{ id: string }>(
      add(world.owner, { key: 'LOG_LEVEL', value: 'debug', type: 'plain' }),
    );
    const listed = await ok<Listed>(api(world.member, 'GET', base()));
    expect(listed.canManage).toBe(false);
    expect(listed.variables[0]).toMatchObject({ key: 'LOG_LEVEL', value: null });
    for (const res of [
      await add(world.member, { key: 'X_KEY', value: 'whatever-long' }),
      await api(world.member, 'POST', `${base()}/${created.id}/reveal`),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res.body)).toBe('PERMISSION_FORBIDDEN');
      expect(JSON.stringify(res.body)).toContain('env.manage');
    }
  });

  it('refuses a protected variable on a non-production environment, a duplicate and a stale change', async () => {
    const prot = await add(world.owner, {
      key: 'SIGNING',
      value: 'abcdefgh',
      environment: 'stg',
      protected: true,
    });
    expect(prot.status).toBe(422);
    expect(codeOf(prot.body)).toBe('VARIABLE_PROTECTED_NOT_PRODUCTION');

    const created = await ok<{ id: string; version: number }>(
      add(world.owner, { key: 'API_KEY', value: 'first-value' }),
    );
    const dup = await add(world.owner, { key: 'API_KEY', value: 'second-value' });
    expect(dup.status).toBe(409);
    expect(codeOf(dup.body)).toBe('VARIABLE_EXISTS');

    const changed = await ok<{ version: number; fingerprint: string }>(
      api(world.owner, 'PUT', `${base()}/${created.id}`, { baseVersion: 1, value: 'second-value' }),
    );
    expect(changed.version).toBe(2);
    const stale = await api(world.owner, 'PUT', `${base()}/${created.id}`, {
      baseVersion: 1,
      protected: true,
    });
    expect(stale.status).toBe(409);
    expect(codeOf(stale.body)).toBe('VARIABLE_STALE');

    await ok(api(world.owner, 'DELETE', `${base()}/${created.id}?baseVersion=2`));
    const left = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM project_secrets WHERE scope = 'var'`,
    );
    expect(left[0]?.n).toBe(0);
    const { events } = await ok<{
      events: { act: string; oldFingerprint: string | null; newFingerprint: string | null }[];
    }>(api(world.owner, 'GET', `${base()}/events`));
    const updated = events.find((e) => e.act === 'updated');
    expect(updated?.oldFingerprint).not.toBe(updated?.newFingerprint);
    expect(events.find((e) => e.act === 'deleted')?.oldFingerprint).toBe(changed.fingerprint);
  });

  it('keeps the variables store out of reach as a plain secret', async () => {
    const res = await api(
      world.owner,
      'PUT',
      `/api/projects/${world.projectId}/secrets/var/anything`,
      {
        value: 'some-secret-value',
      },
    );
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('SECRET_SCOPE_RESERVED');
  });
});

describe('an agent proposes and a person decides (BC-6)', () => {
  it('refuses an agent credential a direct write and a reveal, whatever it holds', async () => {
    const created = await ok<{ id: string }>(
      add(world.owner, { key: 'API_KEY', value: 'first-value' }),
    );
    const write = await add(world.agent, { key: 'OTHER', value: 'other-value' });
    expect(write.status).toBe(403);
    expect(codeOf(write.body)).toBe('VARIABLE_AGENT_PROPOSES');
    const reveal = await api(world.agent, 'POST', `${base()}/${created.id}/reveal`);
    expect(reveal.status).toBe(403);
    expect(codeOf(reveal.body)).toBe('VARIABLE_VALUE_AGENT_REFUSED');
    expect(JSON.stringify(reveal.body)).not.toContain('first-value');
  });

  it('holds a proposal with no effect until approved, then writes it naming proposer and approver', async () => {
    await createTestIssue(world.projectId, world.ownerId, 12, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const proposal = await ok<{ id: string; fingerprint: string; status: string }>(
      api(world.agent, 'POST', `${base()}/proposals`, {
        issue: 'ISS-12',
        act: 'set',
        key: 'S3_BUCKET',
        environment: 'stg',
        type: 'plain',
        value: 'stg-bucket',
        reason: 'ISS-12 reads its uploads from the stg bucket',
      }),
    );
    expect(proposal.status).toBe('proposed');
    expect((await ok<Listed>(api(world.owner, 'GET', base()))).variables).toHaveLength(0);
    const listed = await ok<{ proposals: unknown[] }>(
      api(world.agent, 'GET', `${base()}/proposals`),
    );
    expect(JSON.stringify(listed)).not.toContain('stg-bucket');

    const byAgent = await api(world.agent, 'POST', `${base()}/proposals/${proposal.id}/decision`, {
      decision: 'approve',
      reason: 'self approval',
    });
    expect(codeOf(byAgent.body)).toBe('VARIABLE_AGENT_PROPOSES');

    await ok(
      api(world.owner, 'POST', `${base()}/proposals/${proposal.id}/decision`, {
        decision: 'approve',
        reason: 'the bucket is right',
      }),
    );
    const after = await ok<Listed>(api(world.owner, 'GET', base()));
    expect(after.variables[0]).toMatchObject({
      key: 'S3_BUCKET',
      environment: 'stg',
      value: 'stg-bucket',
    });
    const again = await api(world.owner, 'POST', `${base()}/proposals/${proposal.id}/decision`, {
      decision: 'reject',
      reason: 'too late',
    });
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('VARIABLE_PROPOSAL_DECIDED');
    const held = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM project_secrets WHERE scope = 'var' AND name LIKE 'p-%'`,
    );
    expect(held[0]?.n).toBe(0);
  });

  it('rejects a proposal: nothing changes and the held value is destroyed', async () => {
    await createTestIssue(world.projectId, world.ownerId, 13, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const proposal = await ok<{ id: string }>(
      api(world.agent, 'POST', `${base()}/proposals`, {
        issue: 'ISS-13',
        act: 'set',
        key: 'FEATURE_FLAG',
        environment: null,
        type: 'secret',
        value: 'turned-on-everywhere',
        reason: 'ISS-13 needs it',
      }),
    );
    await ok(
      api(world.owner, 'POST', `${base()}/proposals/${proposal.id}/decision`, {
        decision: 'reject',
        reason: 'not everywhere',
      }),
    );
    expect((await ok<Listed>(api(world.owner, 'GET', base()))).variables).toHaveLength(0);
    const held = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM project_secrets WHERE scope = 'var'`,
    );
    expect(held[0]?.n).toBe(0);
  });

  it('refuses a proposal naming an issue the project does not hold', async () => {
    const res = await api(world.agent, 'POST', `${base()}/proposals`, {
      issue: 'ISS-999',
      act: 'delete',
      key: 'NOPE',
      environment: null,
      reason: 'nothing',
    });
    expect(codeOf(res.body)).toBe('VARIABLE_PROPOSAL_ISSUE_UNKNOWN');
  });
});

describe('a declared run receives the effective variables of the environment it targets (BC-8)', () => {
  beforeEach(async () => {
    await ok(add(world.owner, { key: 'DATABASE_URL', value: ALL_DB }));
    await ok(add(world.owner, { key: 'DATABASE_URL', value: STG_DB, environment: 'stg' }));
    await ok(
      add(world.owner, {
        key: 'STRIPE_KEY',
        value: STRIPE,
        environment: 'production',
        protected: true,
      }),
    );
  });

  it('gives a stg run the stg value over the all-scope one, audits it and scrubs it from the run', async () => {
    await landedIssue(20, 'release/stg');
    const run = await declaredRun(20);
    const res = await runVariables(run.boxRunId, 'stg');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      environment: 'stg',
      variables: [{ key: 'DATABASE_URL', type: 'secret', value: STG_DB }],
      withheld: [],
    });
    const audit = await rows<Record<string, unknown>>(
      sql`SELECT * FROM project_variable_events WHERE act = 'delivered'`,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(STG_DB);
    const posted = await agentSessionsPorts().scrubSessionOutput(run.session, {
      line: `connecting to ${STG_DB}`,
    });
    expect(JSON.stringify(posted)).not.toContain(STG_DB);
  });

  it('refuses a key that does not exist, naming it, and delivers nothing', async () => {
    await landedIssue(21, 'release/stg');
    const run = await declaredRun(21);
    const res = await runVariables(run.boxRunId, 'stg', ['DATABASE_URL', 'REDIS_URL']);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('VARIABLE_KEY_UNKNOWN');
    expect(JSON.stringify(res.body)).toContain('REDIS_URL');
    expect(JSON.stringify(res.body)).not.toContain(STG_DB);
  });

  it('gives a protected variable only to a run targeting production whose work landed there', async () => {
    await landedIssue(22, 'release/stg');
    const stgRun = await declaredRun(22);
    const notLanded = await runVariables(stgRun.boxRunId, 'production', ['STRIPE_KEY']);
    expect(notLanded.status).toBe(403);
    expect(codeOf(notLanded.body)).toBe('VARIABLE_PROTECTED_WITHHELD');
    const listed = await runVariables(stgRun.boxRunId, 'production');
    expect(listed.body).toMatchObject({ withheld: ['STRIPE_KEY'] });
    expect(JSON.stringify(listed.body)).not.toContain(STRIPE);

    await landedIssue(23, 'main');
    const prodRun = await declaredRun(23);
    const res = await runVariables(prodRun.boxRunId, 'production', ['STRIPE_KEY']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ variables: [{ key: 'STRIPE_KEY', value: STRIPE }] });
  });

  it('refuses an environment the project does not declare, and a person session', async () => {
    await landedIssue(24, 'release/stg');
    const run = await declaredRun(24);
    const unknown = await runVariables(run.boxRunId, 'qa');
    expect(codeOf(unknown.body)).toBe('VARIABLE_ENVIRONMENT_UNKNOWN');
    const session = await api(world.owner, 'GET', `/api/jobs/${run.boxRunId}/variables/stg`);
    expect(session.status).toBe(403);
  });
});

describe('a testing profile names a stored variable instead of a copy (BC-7)', () => {
  const profile = (credential: string) => ({
    baseRevision: null,
    document: {
      $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
      version: 1,
      id: 'stg',
      actors: {},
      services: { db: { access: 'readonly', credential } },
      limits: [],
    },
  });

  it('refuses a var:// reference to no variable, and a secret:// copy under the variables store', async () => {
    const unknown = await api(
      world.owner,
      'PUT',
      `/api/projects/${world.projectId}/testing-profiles/stg`,
      profile('var://DATABASE_URL'),
    );
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('VARIABLE_REF_UNKNOWN');
    const reserved = await api(
      world.owner,
      'PUT',
      `/api/projects/${world.projectId}/testing-profiles/stg`,
      profile('secret://var/v-anything'),
    );
    expect(JSON.stringify(reserved.body)).toContain('SECRET_SCOPE_RESERVED');
  });

  it('answers the judge the variable effective on the environment it judges, from the one store', async () => {
    await ok(add(world.owner, { key: 'DATABASE_URL', value: ALL_DB }));
    await ok(add(world.owner, { key: 'DATABASE_URL', value: STG_DB, environment: 'stg' }));
    await ok(
      api(
        world.owner,
        'PUT',
        `/api/projects/${world.projectId}/testing-profiles/stg`,
        profile('var://DATABASE_URL'),
      ),
    );
    await landedIssue(30, 'release/stg');
    const run = await declaredRun(30);
    const res = await api(
      world.boxToken,
      'GET',
      `/api/jobs/${run.boxRunId}/testing-profiles/stg/secrets`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ secrets: [{ ref: 'var://DATABASE_URL', value: STG_DB }] });
    const copies = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM project_secrets WHERE scope <> 'var'`,
    );
    expect(copies[0]?.n).toBe(0);
  });
});
