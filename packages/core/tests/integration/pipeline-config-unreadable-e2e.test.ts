/**
 * ISS-1368 — a stored `pipelineConfig` the schema refuses is refused by name by every reader that
 * parses it, never read as no configuration or as the defaults. Real Postgres and the real HTTP
 * surface, because what is asserted is what each door does with the document a project stores.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const BAD_PATH = ' packages/runner';
const RUNTIMES = [{ name: 'runner', paths: [BAD_PATH], servedBy: 'project-runners' }];
const REFUSED = {
  enabled: true,
  poolBacklog: { statuses: ['confirmed'] },
  releaseRuntimes: RUNTIMES,
};
const PLACE = 'pipelineConfig.releaseRuntimes.0.paths.0';

/** The parts of a reply these cases read. */
type Reply = {
  code?: string;
  message?: string;
  details: { refused: unknown[] };
  pipelineConfig: { releaseRuntimes?: unknown };
};

let harness: TestDatabase;
let server: TestServer;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let ownerId: string;
let refusedId: string;
let soundId: string;
let deviceId: string;

async function call(method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const token = await signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Reply };
}

async function issueAt(projectId: string, status: string, seq: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
  `);
  return id;
}

async function bindDevice(projectId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${projectId}, 'claude-code', ${deviceId}, ${`runner-${projectId}`},
            'online', now(), '[]'::jsonb)
  `);
}

/** What a reader threw, as text, so each case asserts what a person reading it is told. */
async function refusalOf(read: () => Promise<unknown>): Promise<string> {
  const err = await read().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'the reader answered instead of refusing').not.toBeNull();
  return err instanceof Error ? err.message : String(err);
}

function expectNamed(said: string): void {
  expect(said).toContain(refusedId);
  expect(said).toContain(PLACE);
  expect(said).toContain('a release runtime path is a path relative to the repository root');
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = (agentConfig: Record<string, unknown>) =>
    createTestProject(harness.db, ownerId, { orgId: org.id, agentConfig });
  refusedId = (await project({ pipelineConfig: REFUSED })).id;
  soundId = (await project({ pipelineConfig: { poolBacklog: { statuses: ['confirmed'] } } })).id;
  for (const projectId of [refusedId, soundId]) {
    await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  }
  deviceId = (await createTestDevice(harness.db, ownerId)).id;
});

describe('every reader refuses a stored pipelineConfig the schema refuses, by name', () => {
  it('readPipelineConfig refuses it, rather than answering no configuration', async () => {
    const { readPipelineConfig } = await import('../../src/pipeline/autonomous-project.js');
    expectNamed(await refusalOf(() => readPipelineConfig(refusedId)));
  });

  it('a status transition on that project is refused naming it', async () => {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const id = await issueAt(refusedId, 'open', 1);
    const row = { id, projectId: refusedId, status: 'open' as const, reopenCount: 0 };
    const actor = { type: 'user' as const, id: ownerId };
    expectNamed(await refusalOf(() => transitionIssueStatus(row, 'confirmed', actor)));
  });

  it('an autonomous dispatch on that project is refused naming it', async () => {
    const { reEnqueueForIssue } = await import('../../src/pipeline/orchestrator.js');
    const issueId = await issueAt(refusedId, 'open', 2);
    const actor = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    const args = { projectId: refusedId, issueId, status: 'open' as const, actor, reason: {} };
    expectNamed(await refusalOf(() => reEnqueueForIssue(args)));
  });

  it('a manual run on that project is refused naming it', async () => {
    const { triggerPipelineStepManual } = await import('../../src/pipeline/orchestrator.js');
    const issueId = await issueAt(refusedId, 'open', 3);
    const actor = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    const args = { projectId: refusedId, issueId, status: 'open' as const, actor, reason: {} };
    expectNamed(await refusalOf(() => triggerPipelineStepManual(args)));
  });

  it("a device's admissible read names the refused project and still answers for the other", async () => {
    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    await bindDevice(refusedId);
    await bindDevice(soundId);
    const sound = await issueAt(soundId, 'confirmed', 4);
    await issueAt(refusedId, 'confirmed', 5);
    const refused: Array<{ projectId: string; code: string; message: string }> = [];

    const items = await readAdmissibleIssues({ deviceId, refused });

    expect(items.map((i) => i.issueId)).toEqual([sound]);
    expect(refused.map((r) => r.projectId)).toEqual([refusedId]);
    expectNamed(refused[0]?.message ?? '');
    expectNamed(await refusalOf(() => readAdmissibleIssues({ deviceId, projectId: refusedId })));
  });

  it('the REST pipeline-config read is refused naming each key and what is stored at it', async () => {
    const read = await call('GET', `/api/projects/${refusedId}/pipeline-config`);

    expect(read.status).toBe(409);
    expect(read.json.code).toBe('PIPELINE_CONFIG_UNREADABLE');
    expectNamed(String(read.json.message));
    expect(read.json.details.refused).toEqual([
      expect.objectContaining({ path: PLACE, key: 'releaseRuntimes', stored: RUNTIMES }),
    ]);
  });

  it('the MCP forge_config read is refused naming each key and what is stored at it', async () => {
    const { forgeConfigTool } = await import('../../src/mcp/tools/forge-config.js');
    const { PAT_GRANT_ALL } = await import('../../src/auth/pat-permissions.js');
    const principal = {
      kind: 'pat' as const,
      permissions: PAT_GRANT_ALL,
      agency: 'human' as const,
      agentUserId: null,
      deviceId: null,
      userId: ownerId,
      tokenId: randomUUID(),
      scopes: ['read'],
      projectIds: [refusedId],
      boundProjectId: null,
    };
    const tool = forgeConfigTool({ principal, projectSlug: null } as never);

    const said = await refusalOf(() => tool.handler({ action: 'get', projectId: refusedId }));

    expect(said).toMatch(/^BAD_REQUEST: PIPELINE_CONFIG_UNREADABLE: /);
    expectNamed(said);
    expect(said).toContain(JSON.stringify(BAD_PATH));
  });

  it('names every refused document once at boot, and no sound one', async () => {
    const { reportUnreadablePipelineConfigs } = await import('../../src/pipeline/orchestrator.js');

    const named = await reportUnreadablePipelineConfigs();

    expect(named.map((n) => n.projectId)).toEqual([refusedId]);
    expectNamed(named[0]?.message ?? '');
  });

  it('accepts the patch that corrects the refused key, after which the reads answer', async () => {
    const fixed = [{ name: 'runner', paths: ['packages/runner'], servedBy: 'project-runners' }];

    const patched = await call('PATCH', `/api/projects/${refusedId}/pipeline-config`, {
      base: { releaseRuntimes: RUNTIMES },
      patch: { releaseRuntimes: fixed },
    });

    expect(patched.status).toBe(200);
    const read = await call('GET', `/api/projects/${refusedId}/pipeline-config`);
    expect(read.status).toBe(200);
    expect(read.json.pipelineConfig.releaseRuntimes).toEqual(fixed);
  });
});
