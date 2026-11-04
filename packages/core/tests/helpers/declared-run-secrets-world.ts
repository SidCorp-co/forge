/**
 * The world the declared-run testing-secrets tests share: a project whose `stg` environment deploys
 * `release/stg` and names testing profile `stg`, a paired box with its credential, and the issue and
 * run factories over it (ISS-788).
 */
import { randomUUID } from 'node:crypto';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from './api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from './factories.js';
import { seedProjectDocument } from './release-world.js';

export const VALUE = 'stg-admin@adminhub.test:Corr3ct-H0rse-Battery';
export const REF = 'secret://test/stg-admin';

export const world = { ownerId: '', projectId: '', otherId: '', box: '', boxToken: '' };

export async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** A project whose `stg` environment deploys `release/stg` and names testing profile `stg`. */
export async function judgedProject(projectId: string): Promise<void> {
  const token = await userToken(world.ownerId);
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/secrets/test/stg-admin`, { value: VALUE }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${projectId}/testing-profiles/stg`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'stg',
        actors: { admin: { role: 'project-admin', credential: REF } },
        services: {},
        limits: [],
      },
    }),
  );
  await seedProjectDocument(projectId, world.ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        testing: 'stg',
        url: 'https://stg.adminhub.example.test',
      },
    },
  });
}

/** ISS-`seq`, landed on `release/stg` and standing at awaiting_release. */
export async function landedIssue(projectId: string, seq: number): Promise<string> {
  const { id } = await createTestIssue(projectId, world.ownerId, seq, {
    status: 'awaiting_release',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await db.execute(sql`UPDATE issues SET merged_target = 'release/stg' WHERE id = ${id}`);
  return id;
}

/** A run the box's master declared over ISS-`seq`; answers its ids. */
export async function declaredRun(
  projectId: string,
  seq: number,
  over: { box?: string; status?: string; openedAt?: string; boxRunId?: string } = {},
): Promise<{ boxRunId: string; runId: string; session: string }> {
  const boxRunId = over.boxRunId ?? randomUUID();
  const runId = randomUUID();
  const key = `ISS-${seq}`;
  const metadata = {
    boxRunId,
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: over.openedAt ?? 'awaiting_release' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${over.box ?? world.box}, ${runId}, 'run_session', ${over.status ?? 'running'}, now(), now())
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  return { boxRunId, runId, session: s.id };
}

export const secrets = (token: string, id: string, query = 'actor=admin') =>
  api(token, 'GET', `/api/jobs/${id}/testing-profiles/stg/secrets${query ? `?${query}` : ''}`);

export const codeOf = (body: unknown): string | undefined => {
  const b = body as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code;
};

/** Seeds the world every case starts from: an owner, the judged project, another project, the paired box and its credential. */
export async function seedDeclaredRunWorld(): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  world.otherId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  await addProjectMember(world.otherId, world.ownerId, 'admin');
  world.box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  // the box's own credential, which a master's pane and every run it declares call with
  world.boxToken = (
    await mintPat({
      userId: world.ownerId,
      name: deviceTokenNameFor(world.box),
      scopes: ['read', 'write'],
      permissions: ['*'],
      // as `devices/credential.ts:issueDeviceCredential` mints a box a person paired: fenced to none
      projectIds: [],
      onBehalfOf: world.ownerId,
      deviceId: world.box,
    })
  ).plaintext;
  await judgedProject(world.projectId);
}
