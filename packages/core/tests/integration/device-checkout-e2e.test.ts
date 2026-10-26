/**
 * ISS-1236 — a working directory is the device's own, read through one reader, against a real Postgres.
 *
 * The fixture is forge-dev's live shape on 2026-10-26: one project whose own `repo_path_hint` names
 * dev1's checkout, bound on two boxes at two different paths. Before the fix a chat turn on a
 * device with no binding, and every claimed job, was handed the project's path — another box's
 * folder. A third box the project never bound stands as the project's default device.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const PROJECT_DEFAULT = '/home/kieutrung/tools/forge';
const ON_DEV1 = '/home/kieutrung/tools/forge';
const ON_XEON = '/home/dev/forge/projects/forge-core';

let harness: TestDatabase;
let chat: typeof import('../../src/agent-sessions/chat-turn.js');
let prepare: typeof import('../../src/jobs/prepare-claimed-job.js');
let claim: typeof import('../../src/devices/claim.js');
let published: Array<{ room: string; event: string; data: Record<string, unknown> }> = [];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const { roomManager } = await import('../../src/ws/server.js');
  vi.spyOn(roomManager, 'publish').mockImplementation((room, envelope) => {
    const env = envelope as { event: string; data: Record<string, unknown> };
    published.push({ room, event: env.event, data: env.data });
    return 0;
  });
  chat = await import('../../src/agent-sessions/chat-turn.js');
  prepare = await import('../../src/jobs/prepare-claimed-job.js');
  claim = await import('../../src/devices/claim.js');
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  published = [];
});

async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id, { slug: 'forge-dev' });
  const dev1 = await createTestDevice(harness.db, owner.id, { name: 'dev1' });
  const xeon = await createTestDevice(harness.db, owner.id, { name: 'sid-xeon-1' });
  const spare = await createTestDevice(harness.db, owner.id, { name: 'spare-box' });
  await harness.db.execute(sql`
    UPDATE projects SET repo_path_hint = ${PROJECT_DEFAULT}, default_device_id = ${spare.id}
    WHERE id = ${project.id}
  `);
  for (const [device, path] of [
    [dev1, ON_DEV1],
    [xeon, ON_XEON],
  ] as const) {
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, repo_path)
      VALUES (${randomUUID()}, ${project.id}, ${device.id}, 'claude-code', ${device.name},
              'online', now(), ${path})
    `);
  }
  return { owner, project, dev1, xeon, spare };
}

async function queuedJob(projectId: string, ownerId: string): Promise<string> {
  const issue = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issue}, ${projectId}, ${Math.floor(Math.random() * 1e6) + 10}, 'work', 'open', 'high', ${ownerId})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${run}, ${projectId}, ${issue}, 'issue', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at,
                      payload)
    VALUES (${job}, ${projectId}, ${issue}, ${run}, 'code', 'queued', ${ownerId}, now(),
            '{"promptString":"do the step"}'::jsonb)
  `);
  return job;
}

async function sessionCount(projectId: string): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

describe('two devices bound to one project at two paths', () => {
  it('a chat turn on each device carries that device own checkout, never the project path', async () => {
    const { owner, project, dev1, xeon } = await seed();

    for (const [device, path] of [
      [xeon, ON_XEON],
      [dev1, ON_DEV1],
    ] as const) {
      const client = await chat.resolveChatDevice(
        { projectId: project.id, deviceId: null, metadata: null },
        undefined,
        device.id,
      );
      expect(client.checkout).toBe(path);
      const session = await chat.createChatSessionRow({ projectId: project.id, userId: owner.id });
      await chat.dispatchChatTurn({
        session,
        project: { id: project.id, slug: project.slug },
        client,
        message: 'where am I?',
        preBuilt: true,
      });
      const frame = published.find(
        (p) => p.room === `device:${device.id}` && p.event === 'agent:start',
      );
      expect(frame?.data.repoPath, `the frame to ${device.name}`).toBe(path);
    }
    expect(
      published.some((p) => p.data.repoPath === PROJECT_DEFAULT && p.room === `device:${xeon.id}`),
    ).toBe(false);
  });

  it('a job claimed on each device is prepared with that device own checkout', async () => {
    const { owner, project, dev1, xeon } = await seed();

    const onXeon = await prepare.prepareClaimedJob({
      jobId: await queuedJob(project.id, owner.id),
      deviceId: xeon.id,
    });
    const onDev1 = await prepare.prepareClaimedJob({
      jobId: await queuedJob(project.id, owner.id),
      deviceId: dev1.id,
    });

    expect(onXeon.repoPath).toBe(ON_XEON);
    expect(onDev1.repoPath).toBe(ON_DEV1);
  });
});

describe('a device the project never bound', () => {
  it('is refused DEVICE_NOT_BOUND by name before any session row is written', async () => {
    const { project, spare } = await seed();

    const refused = await chat
      .resolveChatDevice(
        { projectId: project.id, deviceId: null, metadata: null },
        undefined,
        spare.id,
      )
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({
      status: 409,
      cause: { code: 'DEVICE_NOT_BOUND', details: { deviceId: spare.id, projectId: project.id } },
    });
    const message = (refused as Error).message;
    expect(message).toContain('spare-box');
    expect(message).toContain('forge-dev');
    // `forge-runner bind` refuses a device the project has not assigned, which is the only state this
    // refusal is shown in: the assignment is named first, the bind only once it is done.
    const assign = message.indexOf("forge-dev's Runners page");
    const bind = message.indexOf(
      'once it is assigned, run `forge-runner bind forge-dev --path <dir>`',
    );
    expect(assign, message).toBeGreaterThanOrEqual(0);
    expect(bind, message).toBeGreaterThan(assign);
    expect(message).not.toContain('<slug>');
    expect(message).not.toContain('<project-slug>');
    expect(await sessionCount(project.id)).toBe(0);
  });

  it('is refused when the pool falls back to it as the project default device', async () => {
    const { project } = await seed();
    await harness.db.execute(
      sql`UPDATE runners SET status = 'offline' WHERE project_id = ${project.id}`,
    );

    const refused = await chat
      .resolveChatDevice({ projectId: project.id, deviceId: null, metadata: null }, undefined)
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ cause: { code: 'DEVICE_NOT_BOUND' } });
    expect(published).toEqual([]);
  });

  it("does not name another tenant's box it was handed by id", async () => {
    const { project } = await seed();
    const stranger = await createTestUser(harness.db);
    const theirs = await createTestDevice(harness.db, stranger.id, { name: 'their-private-box' });

    const refused = await chat
      .resolveChatDevice(
        { projectId: project.id, deviceId: null, metadata: null },
        undefined,
        theirs.id,
      )
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ cause: { code: 'DEVICE_NOT_BOUND' } });
    expect((refused as Error).message).toContain(theirs.id);
    expect((refused as Error).message).not.toContain('their-private-box');
  });

  it('is refused at the pool door by admission, before any hold, and never handed the project path', async () => {
    const { owner, project, spare } = await seed();
    const job = await queuedJob(project.id, owner.id);

    const result = await claim.prepareJobForMaster({
      jobId: job,
      deviceId: spare.id,
      sessionId: 'master-1',
    });

    expect(result).toMatchObject({ ok: false, reason: 'runner_unbound' });
    const rows = (await harness.db.execute(
      sql`SELECT held_by FROM jobs WHERE id = ${job}`,
    )) as unknown as Array<{ held_by: string | null }>;
    expect(rows[0]?.held_by).toBeNull();
  });

  it('cannot prepare a job: refused DEVICE_NOT_BOUND rather than handed the project path', async () => {
    const { owner, project, spare } = await seed();
    const job = await queuedJob(project.id, owner.id);

    const refused = await prepare
      .prepareClaimedJob({ jobId: job, deviceId: spare.id })
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ cause: { code: 'DEVICE_NOT_BOUND' } });
    expect(await sessionCount(project.id)).toBe(0);
  });
});

describe('a binding that records no path', () => {
  it('hands the device no path, so its own config answers, and never the project path', async () => {
    const { owner, project, xeon } = await seed();
    await harness.db.execute(
      sql`UPDATE runners SET repo_path = NULL WHERE project_id = ${project.id} AND device_id = ${xeon.id}`,
    );

    const client = await chat.resolveChatDevice(
      { projectId: project.id, deviceId: null, metadata: null },
      undefined,
      xeon.id,
    );
    const session = await chat.createChatSessionRow({ projectId: project.id, userId: owner.id });
    await chat.dispatchChatTurn({
      session,
      project: { id: project.id, slug: project.slug },
      client,
      message: 'hello',
      preBuilt: true,
    });
    const job = await prepare.prepareClaimedJob({
      jobId: await queuedJob(project.id, owner.id),
      deviceId: xeon.id,
    });

    const frame = published.find((p) => p.event === 'agent:start');
    expect(frame?.data.repoPath).toBeNull();
    expect(job.repoPath).toBeNull();
  });
});
