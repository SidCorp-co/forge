/**
 * A runner box serves several projects and holds one stored PAT, which its owner minted fenced to
 * the one project they pasted it for. A release job for a second project went out on that PAT and
 * every route of its own project answered `404 project not found`, its issues included; with that
 * project's checkout credential it was answered, and then refused the deploy it exists to run,
 * because the project's agent is a plain member (sidcorp-mail on sid-xeon-1-dev, 2026-10-27).
 *
 * Against real Postgres: the fenced PAT is refused by name, saying which token it was and what it
 * reaches, wherever the request names the project; the checkout credential reaches its own project
 * alone and holds the deploy; and the migration gives the grant to each handle minted before it.
 *
 * @direct-test-of packages/core/src/middleware/pat-fence.ts
 * @direct-test-of packages/core/src/conversations/handles.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { issueCheckoutCredential } from '../../src/devices/workspace-credential.js';
import { api, patToken } from '../helpers/api.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedOrg,
  type TestProject,
  truncateAll,
} from '../helpers/factories.js';

const world = {
  ownerId: '',
  forge: undefined as unknown as TestProject,
  mail: undefined as unknown as TestProject,
};

const BOX_PAT_NAME = 'sid-xeon-1-dev box';

/** The credential a pane the box starts for `projectId` carries: its checkout's, minted at provision. */
async function checkoutCredential(projectId: string): Promise<string> {
  const deviceId = await createTestDevice(world.ownerId);
  await bindTestRunner(projectId, deviceId);
  await mintPat({
    userId: world.ownerId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  return issueCheckoutCredential({ deviceId, projectId, holderUserId: world.ownerId });
}

const said = (body: unknown) => JSON.stringify(body);

function expectFenceRefusal(
  res: { status: number; body: Record<string, unknown> },
  where: string,
  reaches: TestProject,
) {
  expect([res.status, res.body.code], said(res.body)).toEqual([403, 'PAT_PROJECT_OUTSIDE_FENCE']);
  const text = said(res.body);
  expect(text).toContain(BOX_PAT_NAME);
  expect(text).toContain(`${reaches.slug} (${reaches.id})`);
  expect(text).toContain(where);
  expect(text).toContain(world.mail.id);
}

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  const orgId = await seedOrg(world.ownerId);
  world.forge = await createTestProject(world.ownerId, { orgId });
  world.mail = await createTestProject(world.ownerId, { orgId });
});

describe("a job for a box's second project, on a box whose PAT is fenced to the first", () => {
  it('is refused by name on the PAT, naming the token and the project it reaches, wherever the project is named', async () => {
    const boxPat = await patToken(world.ownerId, [world.forge.id], BOX_PAT_NAME);
    const issue = await createTestIssue(world.mail.id, world.ownerId, 7, {
      status: 'open',
      createdAt: new Date(),
    });

    const byPath = await api(
      boxPat,
      'GET',
      `/api/projects/${world.mail.id}/release-batches/active`,
    );
    expectFenceRefusal(byPath, 'the path', world.forge);

    const bySlugInPath = await api(
      boxPat,
      'GET',
      `/api/projects/${world.mail.slug}/release-batches/active`,
    );
    expectFenceRefusal(bySlugInPath, 'the path', world.forge);

    const byHeader = await api(boxPat, 'GET', `/api/issues/${issue.id}`, undefined, {
      'x-forge-project-slug': world.mail.slug,
    });
    expect([byHeader.status, byHeader.body.code], said(byHeader.body)).toEqual([
      403,
      'PAT_PROJECT_OUTSIDE_FENCE',
    ]);
    expect(said(byHeader.body)).toContain('the X-Forge-Project-Slug header');
    expect(said(byHeader.body)).toContain(world.mail.slug);

    const byQuery = await api(boxPat, 'GET', `/api/issues/${issue.key}?projectId=${world.mail.id}`);
    expectFenceRefusal(byQuery, 'the projectId query parameter', world.forge);

    expect(said(byPath.body)).not.toContain(boxPat);
  });

  it('says the same of a project that does not exist, so the refusal tells nothing beyond the token', async () => {
    const boxPat = await patToken(world.ownerId, [world.forge.id], BOX_PAT_NAME);
    const ghost = '00000000-0000-4000-8000-00000000dead';
    const res = await api(boxPat, 'GET', `/api/projects/${ghost}/release-batches/active`);
    expect([res.status, res.body.code], said(res.body)).toEqual([403, 'PAT_PROJECT_OUTSIDE_FENCE']);
    expect(said(res.body)).toContain(ghost);
  });

  it('still answers the fenced PAT on the project it reaches, and an unfenced token on both', async () => {
    const boxPat = await patToken(world.ownerId, [world.forge.id], BOX_PAT_NAME);
    const own = await api(
      boxPat,
      'GET',
      `/api/projects/${world.forge.id}/release-batches/active`,
      undefined,
      {
        'x-forge-project-slug': world.forge.slug,
      },
    );
    expect(own.status, said(own.body)).toBe(200);

    const wide = (await mintPat({ userId: world.ownerId, name: 'wide', permissions: ['*'] }))
      .plaintext;
    for (const project of [world.forge, world.mail]) {
      const res = await api(wide, 'GET', `/api/projects/${project.id}/release-batches/active`);
      expect(res.status, said(res.body)).toBe(200);
    }
  });

  it("calls its own project with that project's checkout credential, which holds the deploy, and no other project", async () => {
    const mailPane = await checkoutCredential(world.mail.id);

    const read = await api(
      mailPane,
      'GET',
      `/api/projects/${world.mail.id}/release-batches/active`,
      undefined,
      {
        'x-forge-project-slug': world.mail.slug,
      },
    );
    expect(read.status, said(read.body)).toBe(200);

    // past `deploys.run` the body is read, and this one is refused for its shape: 400, not 403
    const deploy = await api(
      mailPane,
      'POST',
      `/api/projects/${world.mail.id}/integrations/coolify/deploy`,
      { issueId: 'not-a-uuid' },
    );
    expect(deploy.status, said(deploy.body)).toBe(400);

    const other = await api(
      mailPane,
      'GET',
      `/api/projects/${world.forge.id}/release-batches/active`,
    );
    expect([other.status, other.body.code], said(other.body)).toEqual([
      403,
      'PAT_PROJECT_OUTSIDE_FENCE',
    ]);
  });
});

describe('the migration that gives each existing handle the deploy', () => {
  const MIGRATION = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/migrations/0540_a_projects_own_agent_runs_its_release_deploy.sql',
  );

  async function grantsOf(userId: string, projectId: string): Promise<string[]> {
    const [row] = [
      ...(await db.execute(sql`
        SELECT grants FROM project_members WHERE user_id = ${userId} AND project_id = ${projectId}`)),
    ] as Array<{ grants: string[] }>;
    return row?.grants ?? [];
  }

  it('gives it to the handle alone: not to an agent of two projects, a steward, or a person', async () => {
    await checkoutCredential(world.mail.id);
    const [handle] = [
      ...(await db.execute(sql`
        SELECT pm.user_id FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ${world.mail.id} AND u.kind = 'agent'`)),
    ] as Array<{ user_id: string }>;
    const handleId = handle?.user_id as string;
    expect(await grantsOf(handleId, world.mail.id)).toEqual(['deploys.run']);

    // a handle minted before the grant, beside agents that are not the handle
    await db.execute(sql`
      UPDATE project_members SET grants = ARRAY['shares.public']::text[]
      WHERE user_id = ${handleId} AND project_id = ${world.mail.id}`);
    const shared = (await createTestUser({ kind: 'agent' })).id;
    for (const p of [world.forge.id, world.mail.id]) {
      await db.execute(sql`
        INSERT INTO project_members (user_id, project_id, role) VALUES (${shared}, ${p}, 'member')`);
    }
    const { stewardAccountOf } = await import('../../src/steward/account.js');
    const steward = await stewardAccountOf(world.forge.id);
    const person = (await createTestUser({ verified: true })).id;
    await db.execute(sql`
      INSERT INTO project_members (user_id, project_id, role) VALUES (${person}, ${world.mail.id}, 'member')`);

    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

    expect(await grantsOf(handleId, world.mail.id)).toEqual(['shares.public', 'deploys.run']);
    expect(await grantsOf(shared, world.mail.id)).toEqual([]);
    expect(await grantsOf(steward, world.forge.id)).not.toContain('deploys.run');
    expect(await grantsOf(person, world.mail.id)).toEqual([]);
  });
});
