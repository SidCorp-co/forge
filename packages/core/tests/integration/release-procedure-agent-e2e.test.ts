/**
 * ISS-1276 — core writes no release step for any project, and no pre-flight demands an argument to
 * one.
 *
 * At the doors rather than beside them, because each thing proved here is a composition of a
 * project row, a binding and a knowledge entry: what the agent is handed, what the create refuses,
 * and what the batch context answers. `buildReleaseBatchPrompt` takes no release strategy, so a
 * claim about what a strategy produces is only reachable through `createReleaseBatch`.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let probe: Server;
let probeUrl = '';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err, registry] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/integrations/register-all.js'),
  ]);
  registry.registerAllIntegrations();
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);

  probe = createServer((_req, res) => res.end('commit-live'));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
}, 60_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface World {
  projectId: string;
  userId: string;
  token: string;
}

interface Shape {
  provider?: string;
  baseBranch?: string | null;
  releaseModel?: 'promote' | 'publish';
  releaseStrategy?: string | null;
  procedure?: string | null;
}

async function seed(shape: Shape = {}): Promise<World> {
  const provider = shape.provider ?? 'coolify';
  const releaseModel = shape.releaseModel ?? 'promote';
  const releaseStrategy =
    shape.releaseStrategy === undefined
      ? releaseModel === 'promote'
        ? 'merge-branch'
        : null
      : shape.releaseStrategy;
  const baseBranch = shape.baseBranch === undefined ? 'main' : shape.baseBranch;

  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(sql`
    UPDATE projects
       SET base_branch = ${baseBranch}, live_branch = 'production',
           release_model = ${releaseModel}, release_strategy = ${releaseStrategy},
           repo_path = '/srv/app'
     WHERE id = ${project.id}
  `);
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, ${provider}, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, ${provider}, 'deploy', ARRAY['live'], true,
            ${JSON.stringify({
              verify: { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 },
            })}::jsonb)
  `);
  if (shape.procedure) {
    await harness.db.execute(sql`
      INSERT INTO knowledge_entries (project_id, kind, slug, title, body)
      VALUES (${project.id}, 'workflow', 'release-procedure', 'How this project releases',
              ${shape.procedure})
    `);
  }
  const device = await createTestDevice(harness.db, user.id, { status: 'online', name: 'box' });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'box', 'online', now(), '[]'::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id) };
}

let seq = 0;
async function seedIssue(w: World): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${w.userId},
            ${JSON.stringify({ section: 'Skip', userFacing: '-' })}::jsonb, now())
  `);
  return id;
}

async function readiness(w: World): Promise<Array<{ code: string }>> {
  const res = await app.request(`/api/projects/${w.projectId}/release-readiness`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { blockers: Array<{ code: string }> }).blockers;
}

async function create(w: World, issueIds: string[]) {
  const res = await app.request(`/api/projects/${w.projectId}/release-batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueIds }),
  });
  return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
}

/** What the release run is actually handed, read off the job the create enqueued. */
async function promptOf(runId: string): Promise<string> {
  const rows = await harness.db.execute<{ payload: { promptString?: string } }>(sql`
    SELECT payload FROM jobs WHERE pipeline_run_id = ${runId} AND type = 'release_batch' LIMIT 1
  `);
  return rows[0]?.payload?.promptString ?? '';
}

async function contextOf(w: World, runId: string) {
  const res = await app.request(`/api/projects/${w.projectId}/release-batches/${runId}`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
}

/** Cut a batch and hand back its prompt; fails naming the refusal where the door refused. */
async function cut(w: World): Promise<{ runId: string; prompt: string }> {
  const id = await seedIssue(w);
  const created = await create(w, [id]);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = created.body.runId as string;
  return { runId, prompt: await promptOf(runId) };
}

describe('the method a release is handed (ISS-1276)', () => {
  it("carries the project's own procedure verbatim where it declares one", async () => {
    const procedure = '1. ./scripts/ship.sh --no-squash\n2. tag it v$(cat VERSION)';
    const w = await seed({ procedure });

    const { prompt } = await cut(w);

    expect(prompt).toContain("This project's release procedure");
    expect(prompt).toContain(procedure);
    expect(prompt).not.toContain('This project has declared none to Forge.');
  });

  it('names where the method is, and composes nothing, where it declares none', async () => {
    const w = await seed();

    const { prompt } = await cut(w);

    expect(prompt).toContain('This project has declared none to Forge.');
    expect(prompt).toContain('Forge writes no release steps of its own');
    expect(prompt).not.toContain('Merge baseBranch → liveBranch');
    expect(prompt).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(prompt).not.toContain('CHANGELOG.md');
  });

  // anhome's shape: `publish`, one epodsystem binding, no `release-procedure` entry. It reached
  // `foreignChannelRefusal` — "There is nothing below this line: do NOT merge, do NOT promote" —
  // because the only provider that ever declared a deploy step was Coolify.
  it('refuses nothing for a project whose only live channel is epodsystem', async () => {
    const w = await seed({ provider: 'epodsystem', releaseModel: 'publish' });

    const { prompt } = await cut(w);

    expect(prompt).not.toContain('NO default deploy step');
    expect(prompt).not.toContain('do NOT merge');
    expect(prompt).not.toContain('There is nothing below this line');
    expect(prompt).toContain('epodsystem');
  });

  // `null` is not in this list because Postgres refuses it: `projects_release_strategy_chk`
  // requires a strategy under `promote`, so the deleted default's "no releaseStrategy at all"
  // arm answered for a row the database cannot hold.
  it.each(['cherry-pick', 'tag-mr'])(
    'refuses nothing for a promote project declaring releaseStrategy %s',
    async (strategy) => {
      const w = await seed({ releaseStrategy: strategy });

      const { prompt } = await cut(w);

      expect(prompt).not.toContain('Forge has no default procedure for it');
      expect(prompt).not.toMatch(/STOP — this project declares/);
      expect(prompt).not.toContain(`releaseStrategy: ${strategy}`);
    },
  );
});

describe('the branches a release reads (ISS-1276)', () => {
  it('lists no branch blocker for a project that declares no base branch', async () => {
    const w = await seed({ baseBranch: null });
    await seedIssue(w);

    expect((await readiness(w)).map((b) => b.code)).not.toContain('RELEASE_BRANCHES_UNDECLARED');
  });

  it('opens a batch for a project that declares no base branch', async () => {
    const w = await seed({ baseBranch: null });
    const id = await seedIssue(w);

    const created = await create(w, [id]);

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.code).toBeUndefined();
  });

  it('answers the batch context with an absent branch rather than refusing to answer', async () => {
    const w = await seed({ baseBranch: null });
    const id = await seedIssue(w);
    const created = await create(w, [id]);
    expect(created.status).toBe(201);

    const ctx = await contextOf(w, created.body.runId as string);

    // A declared live branch and an undeclared base is a readable state, not a refusal: the
    // context answers each branch as the project declares it.
    expect(ctx.status).toBe(200);
    expect(ctx.body.baseBranch).toBeNull();
    expect(ctx.body.liveBranch).toBe('production');
  });

  it('names no branch line in the prompt where the project declares none', async () => {
    const w = await seed({ baseBranch: null });

    const { prompt } = await cut(w);

    expect(prompt).not.toContain('baseBranch:');
    expect(prompt).toContain('## Batch Release');
  });
});
