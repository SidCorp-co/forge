import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  handleGitHubEvent: typeof import('../../src/webhooks/github-adapter.js').handleGitHubEvent;
};

let harness: TestDatabase;
let mods: Mods;
let ownerId: string;
let projectId: string;
let bindingId: string;
let connectionId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  mods = (await import('../../src/webhooks/github-adapter.js')) as unknown as Mods;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  connectionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${owner.id}, 'github', true)
  `);
  // The default project is the one nobody configured, which is the shape the fleet is in.
  ({ projectId, bindingId } = await seedProject());
});

/** A project plus its own binding; `agentConfig` is what a project stored before ISS-5. */
async function seedProject(agentConfig: Record<string, unknown> = {}) {
  const project = await createTestProject(harness.db, ownerId, { agentConfig });
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${id}, ${connectionId}, ${project.id}, 'github', 'service', true, '{}'::jsonb)
  `);
  return { projectId: project.id, bindingId: id };
}

// ISS-1062 — the handler takes the delivery's own binding rather than a project id, because the
// projection half needs to know WHICH repository the delivery was about and whose credential may
// re-read it. The binding here carries an empty config, which is what the forge-dev binding
// actually held when this was measured: no owner, no repo, no installation.
function evCtx(over: { projectId?: string; bindingId?: string } = {}) {
  return {
    projectId: over.projectId ?? projectId,
    bindingId: over.bindingId ?? bindingId,
    config: {},
    secrets: {},
  };
}

async function rows(forProject = projectId) {
  return (await harness.db.execute(sql`
    SELECT id, external_id, title, description, status, merged_at, source
    FROM issues WHERE project_id = ${forProject} ORDER BY external_id
  `)) as unknown as Array<{
    id: string;
    external_id: string | null;
    title: string;
    description: string | null;
    status: string;
    merged_at: string | Date | null;
    source: string;
  }>;
}

const issueEvent = (action: string, id: number) => ({
  action,
  issue: { id, title: 'upstream bug', body: 'from GitHub' },
});

/**
 * ISS-5 deleted `githubIntake` and the intake gate with it: a GitHub issue never becomes a Forge
 * issue. A project that turned the door on before then still carries the flag in its stored
 * config, which nothing reads, so that is the case each of these is also asked of.
 */
describe('a GitHub issue event writes no Forge issue', () => {
  for (const action of ['opened', 'edited', 'closed', 'reopened']) {
    it(`an issues.${action} delivery writes nothing`, async () => {
      const r = await mods.handleGitHubEvent(evCtx(), 'issues', issueEvent(action, 7001));
      expect(r.actions).toBe(0);
      expect(await rows()).toHaveLength(0);
    });
  }

  it('writes nothing for a project whose stored config still turned the retired door on', async () => {
    const legacy = await seedProject({
      pipelineConfig: { githubIntake: { enabled: true }, intakeGate: { enabled: true } },
    });
    const r = await mods.handleGitHubEvent(evCtx(legacy), 'issues', issueEvent('opened', 7002));
    expect(r.actions).toBe(0);
    expect(await rows(legacy.projectId)).toHaveLength(0);
  });
});
