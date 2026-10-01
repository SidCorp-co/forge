/**
 * ISS-12 — a change landed on `dev` is followed to the environment that runs it, read from the
 * project document alone: `dev` deploys from `dev` on land, so its binding dispatches without a
 * human, and what it runs is its environment state — the Coolify deployment record (stubbed at
 * the Coolify API) and the runtime probe the document declares.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const SHA = '47f061d78ca5ae2de8005f703fae0b8e8a454da3';
const OTHER = 'c59b3f450a8ca14b6c9317490089a4eb98cafc44';
const COOLIFY = 'https://coolify.example.test';
const PROBE = 'https://dev-api.example.test/version';
const DEV_APP = 'dev-app-uuid';
const BETA_APP = 'beta-app-uuid';

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let token: string;
let devBinding: string;
let betaBinding: string;
let gate: typeof import('../../src/pipeline/release-coolify.js');

async function seedBinding(connection: string, resourceUuid: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, config, active)
    VALUES (${id}, ${connection}, ${projectId}, 'coolify', 'deploy',
      ${JSON.stringify({ targets: [{ id: `t-${resourceUuid}`, label: 'App', resourceUuid }] })}::jsonb,
      true)
  `);
  return id;
}

function documentFor(slug: string) {
  return {
    $schema: 'https://forge.sidcorp.co/schemas/project-v1.json',
    version: 1,
    project: { id: projectId, slug, name: 'Dev land' },
    source: {
      type: 'git',
      git: {
        repository: 'github.com/acme/dev-land',
        defaultBranch: 'dev',
        branches: ['dev', 'main'],
      },
    },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: {
      beta: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { binding: betaBinding, trigger: 'on-request' },
      },
      dev: {
        tier: 'dev',
        deploysFrom: 'dev',
        deployment: { binding: devBinding, trigger: 'on-land' },
        verification: {
          runtime: [{ type: 'http', url: PROBE, path: 'sourceCommit', identifies: 'source' }],
        },
      },
    },
    promotions: [{ from: 'dev', to: 'main', via: 'merge' }],
    rollback: { strategy: 'none' },
    execution: {
      plugin: { source: 'acme/plugin', ref: '0123456789abcdef0123456789abcdef01234567' },
    },
  };
}

/** Coolify's deployment list for the dev application, and the dev box's version endpoint. */
function stubTheWorld(served: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin === COOLIFY &&
        url.pathname === `/api/v1/deployments/applications/${DEV_APP}`
      ) {
        return Response.json({
          count: 1,
          deployments: [
            {
              deployment_uuid: 'dep-dev-1',
              status: 'finished',
              created_at: '2026-10-01T06:00:00Z',
              commit: SHA,
            },
          ],
        });
      }
      if (`${url.origin}${url.pathname}` === PROBE) return Response.json({ sourceCommit: served });
      throw new Error(`no stub answers ${url.href}`);
    }),
  );
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
  await truncateAll(harness.db);

  const admin = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const org = await seedOrg(harness.db, admin.id);
  const project = await createTestProject(harness.db, admin.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: admin.id, role: 'admin' });

  const { encryptJson } = await import('../../src/integrations/vault.js');
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connection}, 'user', ${admin.id}, 'coolify',
      ${JSON.stringify({ baseUrl: COOLIFY })}::jsonb, ${encryptJson({ apiToken: 'tok' })}, true)
  `);
  devBinding = await seedBinding(connection, DEV_APP);
  betaBinding = await seedBinding(connection, BETA_APP);

  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(admin.id);
  gate = await import('../../src/pipeline/release-coolify.js');
  ({ app } = await import('../../src/index.js'));

  const put = await app.request(`/api/projects/${projectId}/config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevision: null, document: documentFor(project.slug) }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await harness?.cleanup?.();
});

async function devState(): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/projects/${projectId}/environments/dev/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('a land on dev, read from the project document', () => {
  it('dispatches the dev binding without a human, and parks the production one', async () => {
    const pairOf = async (id: string) => {
      const [row] = (await harness.db.execute(
        sql`SELECT id, config FROM integration_bindings WHERE id = ${id}`,
      )) as unknown as { id: string; config: unknown }[];
      return row as { id: string; config: unknown };
    };
    expect(await gate.bindingReachesProduction(projectId, await pairOf(devBinding))).toBe(false);
    expect(await gate.liveActionNeedsHumanConfirm(projectId, await pairOf(devBinding))).toBe(false);
    expect(await gate.liveActionNeedsHumanConfirm(projectId, await pairOf(betaBinding))).toBe(true);
  });

  it('reaches environment state `deployed` with a confirmed probe', async () => {
    stubTheWorld(SHA);

    expect(await devState()).toEqual({
      environment: 'dev',
      state: 'deployed',
      evidence: 'runtime-confirmed',
      deployment: {
        id: 'dep-dev-1',
        provider: 'coolify',
        status: 'succeeded',
        at: '2026-10-01T06:00:00.000Z',
      },
      artifact: null,
      source: { kind: 'revision', revision: SHA },
      probes: [{ url: PROBE, identifies: 'source', status: 'confirmed', observed: SHA }],
    });
  });

  it('says mismatch, naming both commits, where the box serves another one', async () => {
    stubTheWorld(OTHER);

    expect(await devState()).toMatchObject({
      state: 'deployed',
      evidence: 'runtime-mismatch',
      probes: [{ status: 'mismatch', observed: OTHER, expected: SHA }],
    });
  });
});
