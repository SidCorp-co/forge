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

const OPEN_DOOR = { pipelineConfig: { githubIntake: { enabled: true } } };
const OPEN_DOOR_GATED = {
  pipelineConfig: { githubIntake: { enabled: true }, intakeGate: { enabled: true, notify: false } },
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

/** A project plus its own binding, so the two door settings can differ per case. */
async function seedProject(agentConfig: Record<string, unknown> = {}) {
  const project = await createTestProject(harness.db, ownerId, { agentConfig });
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
    VALUES (${id}, ${connectionId}, ${project.id}, 'github', 'service', ARRAY[]::text[], true, '{}'::jsonb)
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

const openedEvent = (id: number, title: string, body: string | null) => ({
  action: 'opened',
  issue: { id, title, body },
});

describe('the door decides whether anything enters', () => {
  it('a project that never set githubIntake admits nothing', async () => {
    const r = await mods.handleGitHubEvent(
      evCtx(),
      'issues',
      openedEvent(7001, 'upstream bug', 'from GitHub'),
    );
    expect(r.actions).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('an explicit false admits nothing', async () => {
    const shut = await seedProject({ pipelineConfig: { githubIntake: { enabled: false } } });
    await mods.handleGitHubEvent(
      evCtx(shut),
      'issues',
      openedEvent(7002, 'upstream bug', 'from GitHub'),
    );
    expect(await rows(shut.projectId)).toHaveLength(0);
  });

  it('an open door with no intake gate admits the report at open', async () => {
    const open = await seedProject(OPEN_DOOR);
    const r = await mods.handleGitHubEvent(
      evCtx(open),
      'issues',
      openedEvent(7003, 'upstream bug', 'from GitHub'),
    );
    expect(r.actions).toBe(1);

    const all = await rows(open.projectId);
    expect(all).toHaveLength(1);
    expect(all[0]?.source).toBe('github');
    expect(all[0]?.external_id).toBe('7003');
    expect(all[0]?.status).toBe('open');
    expect(all[0]?.title).toBe('upstream bug');
  });

  it('an open door with the intake gate on parks the report at draft', async () => {
    const gated = await seedProject(OPEN_DOOR_GATED);
    const r = await mods.handleGitHubEvent(
      evCtx(gated),
      'issues',
      openedEvent(7004, 'a stranger reports a bug', 'from GitHub'),
    );
    expect(r.actions).toBe(1);

    const all = await rows(gated.projectId);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('draft');
  });

  it('a gated arrival carries the intake label', async () => {
    const gated = await seedProject(OPEN_DOOR_GATED);
    await mods.handleGitHubEvent(
      evCtx(gated),
      'issues',
      openedEvent(7005, 'a stranger reports a bug', null),
    );
    const [row] = await rows(gated.projectId);

    const labelled = (await harness.db.execute(sql`
      SELECT l.name FROM issue_labels il
      JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = ${row?.id}
    `)) as unknown as Array<{ name: string }>;
    expect(labelled.map((l) => l.name)).toContain('intake');
  });

  it('an intake gate with no githubIntake admits nothing', async () => {
    const gateOnly = await seedProject({
      pipelineConfig: { intakeGate: { enabled: true, notify: false } },
    });
    await mods.handleGitHubEvent(
      evCtx(gateOnly),
      'issues',
      openedEvent(7006, 'upstream bug', null),
    );
    expect(await rows(gateOnly.projectId)).toHaveLength(0);
  });
});

describe('it enters once, and no later event touches it', () => {
  let open: { projectId: string; bindingId: string };

  beforeEach(async () => {
    open = await seedProject(OPEN_DOOR);
    await mods.handleGitHubEvent(
      evCtx(open),
      'issues',
      openedEvent(8001, 'as GitHub first said it', 'as GitHub first wrote it'),
    );
  });

  /** What Forge itself does to the row after admission, which is the thing at risk. */
  async function rewriteLocally() {
    await harness.db.execute(sql`
      UPDATE issues SET title = 'as Forge rewrote it', description = 'as Forge rewrote it',
                        status = 'in_progress'
      WHERE project_id = ${open.projectId} AND external_id = '8001'
    `);
  }

  it('a replayed opened creates no second row', async () => {
    const r = await mods.handleGitHubEvent(
      evCtx(open),
      'issues',
      openedEvent(8001, 'as GitHub first said it', 'as GitHub first wrote it'),
    );
    expect(r.actions).toBe(0);
    expect(await rows(open.projectId)).toHaveLength(1);
  });

  it('a replayed opened leaves the title Forge last set', async () => {
    await rewriteLocally();
    await mods.handleGitHubEvent(
      evCtx(open),
      'issues',
      openedEvent(8001, 'as GitHub NOW says it', 'as GitHub NOW writes it'),
    );
    const [row] = await rows(open.projectId);
    expect(row?.title).toBe('as Forge rewrote it');
  });

  it('a replayed opened leaves the status Forge last set', async () => {
    await rewriteLocally();
    await mods.handleGitHubEvent(
      evCtx(open),
      'issues',
      openedEvent(8001, 'as GitHub NOW says it', null),
    );
    const [row] = await rows(open.projectId);
    expect(row?.status).toBe('in_progress');
  });

  it('an edited delivery leaves the title untouched', async () => {
    await rewriteLocally();
    const r = await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'edited',
      issue: { id: 8001, title: 'retitled on GitHub', body: 'rewritten on GitHub' },
    });
    expect(r.actions).toBe(0);
    const [row] = await rows(open.projectId);
    expect(row?.title).toBe('as Forge rewrote it');
  });

  it('an edited delivery leaves the description untouched', async () => {
    await rewriteLocally();
    await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'edited',
      issue: { id: 8001, title: 'retitled on GitHub', body: 'rewritten on GitHub' },
    });
    const [row] = await rows(open.projectId);
    expect(row?.description).toBe('as Forge rewrote it');
  });

  it('a closed delivery leaves the status untouched', async () => {
    await rewriteLocally();
    const r = await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'closed',
      issue: { id: 8001 },
    });
    expect(r.actions).toBe(0);
    const [row] = await rows(open.projectId);
    expect(row?.status).toBe('in_progress');
  });

  it('a closed delivery leaves merged_at NULL where it was NULL', async () => {
    await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'closed',
      issue: { id: 8001 },
    });
    const [row] = await rows(open.projectId);
    expect(row?.merged_at).toBeNull();
  });

  it('a closed delivery leaves an already-stamped merged_at exactly as it stood', async () => {
    const stamped = '2026-09-01T12:00:00.000Z';
    await harness.db.execute(sql`
      UPDATE issues SET merged_at = ${stamped}::timestamptz
      WHERE project_id = ${open.projectId} AND external_id = '8001'
    `);
    await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'closed',
      issue: { id: 8001 },
    });
    const [row] = await rows(open.projectId);
    expect(row?.merged_at).not.toBeNull();
    expect(new Date(row?.merged_at as string | Date).toISOString()).toBe(stamped);
  });

  it('an edited delivery for an id no row holds creates no row', async () => {
    await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'edited',
      issue: { id: 999_001, title: 'never admitted', body: 'never admitted' },
    });
    expect(await rows(open.projectId)).toHaveLength(1);
  });

  it('a closed delivery for an id no row holds creates no row', async () => {
    await mods.handleGitHubEvent(evCtx(open), 'issues', {
      action: 'closed',
      issue: { id: 999_002 },
    });
    expect(await rows(open.projectId)).toHaveLength(1);
  });
});

describe('a pull request is not a unit of work', () => {
  it('an opened pull request creates no issue', async () => {
    const open = await seedProject(OPEN_DOOR);
    const r = await mods.handleGitHubEvent(evCtx(open), 'pull_request', { action: 'opened' });
    expect(r.actions).toBe(0);
    expect(await rows(open.projectId)).toHaveLength(0);
  });

  it('a full pull_request payload writes a projection row and still no issue', async () => {
    const open = await seedProject(OPEN_DOOR);
    const r = await mods.handleGitHubEvent(evCtx(open), 'pull_request', {
      action: 'opened',
      pull_request: {
        number: 41,
        title: 'a change under review',
        state: 'open',
        updated_at: '2026-09-17T01:00:00Z',
        head: { ref: 'ISS-9999-nothing', sha: 'a'.repeat(40) },
        base: { ref: 'main', sha: 'b'.repeat(40) },
      },
      repository: { full_name: 'SidCorp-co/forge' },
    });
    expect(r.actions).toBe(1);
    expect(await rows(open.projectId)).toHaveLength(0);
    const projected = (await harness.db.execute(sql`
      SELECT number, head_ref, issue_id FROM repo_pull_requests WHERE binding_id = ${open.bindingId}
    `)) as unknown as Array<{ number: number; head_ref: string; issue_id: string | null }>;
    expect(projected).toHaveLength(1);
    expect(projected[0]?.number).toBe(41);
    expect(projected[0]?.issue_id).toBeNull();
  });
});
