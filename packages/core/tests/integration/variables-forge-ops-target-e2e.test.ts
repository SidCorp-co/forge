/**
 * A forge-ops compose target receives its environment's variables server-side (REQ-80 BC-10), against
 * real Postgres and a stand-in forge-ops on the project's box: a sync an agent asks, and a forge-ops
 * deploy through Forge, write the effective variables of the environment into the target's env file
 * (a scoped variable over an all-scope one, a protected one only on a production-tier environment),
 * each write audited by key and fingerprint, and no value in the caller's answer or the audit, even
 * where forge-ops echoes it. A deployment Forge cannot write to is refused by name, naming what to
 * bind; a write forge-ops refused stops the deploy.
 *
 * @direct-test-of packages/core/src/project-config/variables-target.ts
 * @direct-test-of packages/core/src/project-config/variables-target-door.ts
 * @direct-test-of packages/core/src/project-config/variables-routes.ts
 * @direct-test-of packages/core/src/support/declared-read.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { sql } from 'drizzle-orm';
import { mintPat } from '../../src/credentials/pat.js';
import { workspaceTokenNameFor } from '../../src/credentials/pat-format.js';
import { projectConfigPorts, provideProjectConfigPorts } from '../../src/project-config/ports.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
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
  projectId: '',
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

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  const memberId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  await addProjectMember(world.projectId, memberId, 'member');
  world.owner = await userToken(world.ownerId);
  world.member = await userToken(memberId);
  const box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, box);
  world.agent = (
    await mintPat({
      userId: world.ownerId,
      name: workspaceTokenNameFor(box, world.projectId),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [world.projectId],
      deviceId: box,
    })
  ).plaintext;
});

/**
 * A stand-in forge-ops on the project's box: it takes the argv core sends the box, keeps each
 * target's env file as `KEY=value` lines, deploys by noting the file it deployed on, and echoes its
 * argv to stdout and stderr the way a careless CLI might, so a value core failed to cut would show.
 */
function standInForgeOps() {
  const files = new Map<string, Map<string, string>>();
  const deploys: { target: string; args: Record<string, unknown>; envFile: string }[] = [];
  const calls: { argv: string[]; secrets: unknown }[] = [];
  let failOn: string | null = null;
  const envFile = (target: string) =>
    [...(files.get(target) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  type Call = Parameters<ReturnType<typeof projectConfigPorts>['runOpsCall']>[0];
  const runOpsCall = async (input: Call) => {
    calls.push({ argv: input.argv, secrets: input.secrets });
    const [, tool, raw] = input.argv;
    const args = JSON.parse(raw ?? '{}') as Record<string, string>;
    const echo = input.argv.join(' ');
    const cut = (text: string) =>
      Object.entries(input.cut).reduce((t, [n, v]) => t.split(v).join(`[secret ${n}]`), text);
    const answer = (exitCode: number) => ({
      ok: true as const,
      value: {
        name: input.name,
        exitCode,
        stdout: cut(`ran ${echo}`),
        stderr: cut(exitCode === 0 ? '' : `refused ${echo}`),
        truncated: false,
        timedOut: false,
        durationMs: 5,
      },
    });
    if (failOn !== null && args.key === failOn) return answer(1);
    if (tool === 'env' && args.action === 'set') {
      const file = files.get(args.target as string) ?? new Map<string, string>();
      file.set(args.key as string, args.value as string);
      files.set(args.target as string, file);
      return answer(0);
    }
    if (tool === 'deploy') {
      deploys.push({
        target: args.target as string,
        args,
        envFile: envFile(args.target as string),
      });
      return answer(0);
    }
    return answer(2);
  };
  return {
    runOpsCall,
    files,
    deploys,
    calls,
    envFile,
    failOn: (key: string | null) => {
      failOn = key;
    },
  };
}

const FORGE_OPS = '/home/dev/.local/bin/forge-ops';
const forgeOpsAt = (target: string) => ({
  program: FORGE_OPS,
  target,
  secrets: [{ env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/forge-ops-credential' }],
});

describe('a forge-ops compose target receives its environment variables server-side (BC-10)', () => {
  let ops: ReturnType<typeof standInForgeOps>;
  const held = { ports: null as ReturnType<typeof projectConfigPorts> | null };
  const sync = (token: string, environment: string) =>
    api(
      token,
      'POST',
      `/api/projects/${world.projectId}/environments/${environment}/variables/sync`,
    );
  const deploy = (token: string, environment: string, args: Record<string, unknown>) =>
    api(
      token,
      'POST',
      `/api/projects/${world.projectId}/environments/${environment}/forge-ops/deploy`,
      {
        args,
      },
    );

  beforeEach(async () => {
    ops = standInForgeOps();
    held.ports = projectConfigPorts();
    provideProjectConfigPorts({ ...held.ports, runOpsCall: ops.runOpsCall });
    await seedProjectDocument(world.projectId, world.ownerId, {
      defaultBranch: 'main',
      promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
      environments: {
        stg: {
          tier: 'staging',
          deploysFrom: 'release/stg',
          deployment: { mode: 'external', target: 'forge-ops', forgeOps: forgeOpsAt('epod-stg') },
        },
        production: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { mode: 'external', target: 'forge-ops', forgeOps: forgeOpsAt('epodsystem') },
        },
        preview: { tier: 'preview', deployment: { mode: 'external', target: 'a CI pipeline' } },
      },
    });
    await ok(add(world.owner, { key: 'DATABASE_URL', value: ALL_DB }));
    await ok(add(world.owner, { key: 'DATABASE_URL', value: STG_DB, environment: 'stg' }));
    await ok(add(world.owner, { key: 'LOG_LEVEL', value: 'warn', type: 'plain' }));
    await ok(
      add(world.owner, {
        key: 'STRIPE_KEY',
        value: STRIPE,
        environment: 'production',
        protected: true,
      }),
    );
    await ok(
      add(world.owner, {
        key: 'SENTRY_DSN',
        value: 'https://Pub1icKey@sentry.example/42',
        protected: true,
      }),
    );
  });

  afterEach(() => {
    if (held.ports) provideProjectConfigPorts(held.ports);
  });

  it("writes production's variables into its target's env file on a sync an agent asks, with no value in its answer or the audit", async () => {
    const res = await sync(world.agent, 'production');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ops.files.get('epodsystem')).toEqual(
      new Map([
        ['DATABASE_URL', ALL_DB],
        ['LOG_LEVEL', 'warn'],
        ['SENTRY_DSN', 'https://Pub1icKey@sentry.example/42'],
        ['STRIPE_KEY', STRIPE],
      ]),
    );
    expect(ops.calls.every((c) => c.argv[0] === FORGE_OPS && c.argv[1] === 'env')).toBe(true);
    expect(ops.calls[0]?.secrets).toEqual(forgeOpsAt('epodsystem').secrets);
    expect(res.body).toMatchObject({
      environment: 'production',
      target: { kind: 'forge-ops', name: 'epodsystem' },
      via: 'sync',
      withheld: [],
    });
    const written = (res.body as { written: { key: string; fingerprint: string }[] }).written;
    expect(written.map((w) => w.key)).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
      'SENTRY_DSN',
      'STRIPE_KEY',
    ]);
    for (const secret of [ALL_DB, STRIPE, 'Pub1icKey']) {
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    const audit = await rows<{
      key: string;
      new_fingerprint: string;
      detail: Record<string, unknown>;
    }>(
      sql`SELECT key, new_fingerprint, detail FROM project_variable_events WHERE act = 'delivered' ORDER BY key`,
    );
    expect(audit.map((a) => a.key)).toEqual(written.map((w) => w.key));
    expect(audit.map((a) => a.new_fingerprint)).toEqual(written.map((w) => w.fingerprint));
    expect(audit[0]?.detail).toMatchObject({
      environment: 'production',
      target: { kind: 'forge-ops', name: 'epodsystem' },
      via: 'sync',
    });
    expect(JSON.stringify(audit)).not.toContain(STRIPE);
    expect(JSON.stringify(audit)).not.toContain(ALL_DB);
  });

  it('writes no protected variable into a non-production target, and says which it withheld', async () => {
    const res = await sync(world.agent, 'stg');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ops.files.get('epod-stg')).toEqual(
      new Map([
        ['DATABASE_URL', STG_DB],
        ['LOG_LEVEL', 'warn'],
      ]),
    );
    expect(ops.envFile('epod-stg')).not.toContain('Pub1icKey');
    expect(res.body).toMatchObject({ withheld: [{ key: 'SENTRY_DSN' }] });
    expect(JSON.stringify(res.body)).toContain('reaches only a production-tier environment');
  });

  it('writes the env file before a forge-ops deploy through Forge, which deploys on it, its echo cut of every secret', async () => {
    const res = await deploy(world.agent, 'production', {
      service: 'go-backend',
      version: 'v1.50.0',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ops.deploys).toHaveLength(1);
    expect(ops.deploys[0]?.args).toEqual({
      service: 'go-backend',
      version: 'v1.50.0',
      target: 'epodsystem',
    });
    expect(ops.deploys[0]?.envFile).toContain(`STRIPE_KEY=${STRIPE}`);
    expect(res.body).toMatchObject({ via: 'deploy', deploy: { exitCode: 0 } });
    expect(JSON.stringify(res.body)).not.toContain(STRIPE);
    expect((res.body as { deploy: { stdout: string } }).deploy.stdout).toContain('go-backend');
    const audit = await rows<{ detail: { via?: string } }>(
      sql`SELECT detail FROM project_variable_events WHERE act = 'delivered'`,
    );
    expect(audit).toHaveLength(4);
    expect(audit.every((a) => a.detail.via === 'deploy')).toBe(true);
  });

  it('refuses a target Forge cannot write to by name, naming what to bind, and runs nothing', async () => {
    const res = await sync(world.agent, 'preview');
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe('VARIABLE_TARGET_UNBOUND');
    expect(JSON.stringify(res.body)).toContain('environments.preview.deployment');
    expect(JSON.stringify(res.body)).toContain('forgeOps');
    const refusedDeploy = await deploy(world.agent, 'preview', { service: 'web' });
    expect(codeOf(refusedDeploy.body)).toBe('VARIABLE_TARGET_UNBOUND');
    expect(ops.calls).toHaveLength(0);
  });

  it('stops at a write forge-ops refused: names it and what was written, never deploys, never shows the value', async () => {
    ops.failOn('STRIPE_KEY');
    const res = await deploy(world.agent, 'production', { service: 'go-backend' });
    expect(res.status).toBe(503);
    expect(codeOf(res.body)).toBe('VARIABLE_TARGET_WRITE_FAILED');
    expect(JSON.stringify(res.body)).toContain('STRIPE_KEY');
    expect(JSON.stringify(res.body)).toContain('DATABASE_URL, LOG_LEVEL, SENTRY_DSN');
    expect(JSON.stringify(res.body)).not.toContain(STRIPE);
    expect(JSON.stringify(res.body)).toContain('[secret variable STRIPE_KEY]');
    expect(ops.deploys).toHaveLength(0);
    const audit = await rows<{ key: string }>(
      sql`SELECT key FROM project_variable_events WHERE act = 'delivered' ORDER BY key`,
    );
    expect(audit.map((a) => a.key)).toEqual(['DATABASE_URL', 'LOG_LEVEL', 'SENTRY_DSN']);
  });

  it('refuses a member who does not hold deploys.run', async () => {
    const res = await sync(world.member, 'production');
    expect(res.status).toBe(403);
    expect(ops.calls).toHaveLength(0);
  });
});
