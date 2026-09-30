/**
 * ISS-5 — a project is created with a policy, so it dispatches under a document its owner can
 * read, and the driver deny list reaches its jobs without anybody having saved a state first. The
 * write shares the project's transaction; only a real one can show that a refused create leaves
 * no policy behind.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('createProject writes the default policy (ISS-5)', () => {
  let harness: TestDatabase;
  let mods: {
    createProject: typeof import('../../src/projects/service.js')['createProject'];
    requirePolicy: typeof import('../../src/project-config/dispatch-policy.js')['requirePolicy'];
    dispatchStateOf: typeof import('../../src/project-config/dispatch-policy.js')['dispatchStateOf'];
    DEFAULT_POLICY: typeof import('../../src/project-config/default-policy.js')['DEFAULT_POLICY'];
    DRIVER_DENY: typeof import('../../src/project-config/default-policy.js')['DRIVER_DENY'];
  };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const [service, dispatch, defaults] = await Promise.all([
      import('../../src/projects/service.js'),
      import('../../src/project-config/dispatch-policy.js'),
      import('../../src/project-config/default-policy.js'),
    ]);
    mods = {
      createProject: service.createProject,
      requirePolicy: dispatch.requirePolicy,
      dispatchStateOf: dispatch.dispatchStateOf,
      DEFAULT_POLICY: defaults.DEFAULT_POLICY,
      DRIVER_DENY: defaults.DRIVER_DENY,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function anOrg() {
    const user = await createTestUser(harness.db);
    const seedProject = await createTestProject(harness.db, user.id);
    return { userId: user.id, orgId: seedProject.orgId };
  }

  it('stores the default as revision 1, written by the creator', async () => {
    const { userId, orgId } = await anOrg();
    const project = await mods.createProject({
      slug: 'fresh-one',
      name: 'Fresh',
      orgId,
      createdBy: userId,
    });

    const rows = (await harness.db.execute(sql`
      SELECT revision, document, updated_by FROM project_policies WHERE project_id = ${project.id}
    `)) as unknown as Array<{ revision: number; document: unknown; updated_by: string }>;
    expect(rows).toEqual([{ revision: 1, document: mods.DEFAULT_POLICY, updated_by: userId }]);
  });

  it('denies every state the driver deny list, so a new project needs no saved state for it', async () => {
    const { userId, orgId } = await anOrg();
    const project = await mods.createProject({
      slug: 'fresh-two',
      name: 'Fresh',
      orgId,
      createdBy: userId,
    });

    const held = await mods.requirePolicy(project.id);
    for (const status of ['open', 'in_progress', 'needs_info', null]) {
      const state = mods.dispatchStateOf(project.id, held, { status, from: 'issue' });
      expect(state.deniedTools).toEqual([...mods.DRIVER_DENY]);
    }
  });

  it('leaves no policy behind when the create itself is refused', async () => {
    const { userId, orgId } = await anOrg();
    await mods.createProject({ slug: 'taken', name: 'First', orgId, createdBy: userId });

    await expect(
      mods.createProject({ slug: 'taken', name: 'Second', orgId, createdBy: userId }),
    ).rejects.toThrow();

    const [count] = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM project_policies
    `)) as unknown as Array<{ n: number }>;
    expect(count?.n).toBe(2);
  });
});
