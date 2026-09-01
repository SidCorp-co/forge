/**
 * ISS-894 wave 2 — the REST routes that took over from four MCP tools.
 *
 * Every case here exists because a tool went away and its behaviour had to
 * land somewhere that a PAT can reach and a real Postgres can contradict.
 * `forge-ops-health.test.ts` was the only coverage `readOpsHealth` had, and
 * it ran against a stubbed drizzle: it could not have caught a wrong join,
 * only a wrong call. These run the query.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
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

  const [health, charter, targets, batch, ux, collab, pin, jwt, err] = await Promise.all([
    import('../../src/health/routes.js'),
    import('../../src/skills/divergence-charter-routes.js'),
    import('../../src/integrations/target-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/projects/ux-contract-routes.js'),
    import('../../src/projects/collaborators-routes.js'),
    import('../../src/skills/pin-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;

  app = new Hono();
  app.route('/', health.publicHealthRoutes);
  app.route('/api/projects', health.opsHealthProjectRoutes);
  app.route('/api/me', health.opsHealthMeRoutes);
  app.route('/api/me', collab.collaboratorsMeRoutes);
  app.route('/api/projects', pin.skillPinRoutes);
  app.route('/api/projects', charter.divergenceCharterRoutes);
  app.route('/api/projects', targets.integrationTargetRoutes);
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.route('/api/projects', ux.uxContractProjectRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function verifiedUser() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { user, token: await signUserToken(user.id) };
}

async function seed() {
  const { user, token } = await verifiedUser();
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  return { user, project, token };
}

// cm:guard a project role BELOW admin only exists for someone who is not the org owner — `effectiveProjectRole` is org-aware and hands the org owner implicit project admin, so seeding role:'member' on the project creator produces an admin and every negative role case passes for the wrong reason.
async function seedNonAdminMember(project: { id: string; orgId: string }) {
  const { user, token } = await verifiedUser();
  await createTestOrgMember(harness.db, {
    orgId: project.orgId,
    userId: user.id,
    role: 'member',
  });
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'member',
  });
  return { user, token };
}

function call(path: string, token?: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

describe('GET /version — replaces forge_version', () => {
  it('answers 200 with version and uptime, unauthenticated', async () => {
    const res = await call('/version');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; uptimeSeconds: number };
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });

  it('still serves /health beside it after the move out of index.ts', async () => {
    const res = await call('/health');
    expect([200, 503]).toContain(res.status);
    expect((await res.json()) as { db: { ok: boolean } }).toMatchObject({ db: { ok: true } });
  });
});

describe('ops-health — replaces forge_ops_health', () => {
  it('returns the project the caller is a member of, and its runners', async () => {
    const { project, token } = await seed();
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, name, status)
      VALUES (${runnerId}, ${project.id}, 'claude-code', 'remote', 'r1', 'online')
    `);

    const res = await call(`/api/projects/${project.id}/ops-health`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      projects: Array<{ id: string }>;
      runners: Array<{ id: string; projectId: string }>;
    };
    expect(body.projects.map((p) => p.id)).toEqual([project.id]);
    expect(body.runners.map((r) => r.id)).toContain(runnerId);
  });

  it('refuses a project the caller cannot see', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await call(`/api/projects/${theirs.project.id}/ops-health`, mine.token);
    expect([403, 404]).toContain(res.status);
  });

  it('the /api/me fan-out spans every visible project, which the per-project route cannot', async () => {
    const { user, project, token } = await seed();
    const second = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: second.id,
      role: 'member',
    });

    const res = await call('/api/me/ops-health', token);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { projects: Array<{ id: string }> }).projects.map(
      (p) => p.id,
    );
    expect(ids).toContain(project.id);
    expect(ids).toContain(second.id);
  });

  it('rejects a stale-job threshold outside the accepted band', async () => {
    const { project, token } = await seed();
    const res = await call(
      `/api/projects/${project.id}/ops-health?staleJobThresholdSeconds=1`,
      token,
    );
    expect(res.status).toBe(400);
  });
});

describe('divergence charter — replaces forge_divergence_charters', () => {
  const entry = (id: string, difference: string) => ({
    id,
    skill: 'forge-code',
    difference,
    reason: 'measured',
    incidentRefs: ['ISS-795'],
    revertable: true,
  });

  it('reads null before anything is written', async () => {
    const { project, token } = await seed();
    const res = await call(`/api/projects/${project.id}/divergence-charter`, token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { charter: unknown }).toEqual({ charter: null });
  });

  it('PUT replaces the entry list rather than merging into it', async () => {
    const { project, token } = await seed();
    const first = await call(`/api/projects/${project.id}/divergence-charter`, token, {
      method: 'PUT',
      body: JSON.stringify({ entries: [entry('a', 'one'), entry('b', 'two')] }),
    });
    expect(first.status).toBe(200);

    const second = await call(`/api/projects/${project.id}/divergence-charter`, token, {
      method: 'PUT',
      body: JSON.stringify({ entries: [entry('c', 'three')], reason: 'narrowed' }),
    });
    expect(second.status).toBe(200);

    const res = await call(`/api/projects/${project.id}/divergence-charter`, token);
    const { charter } = (await res.json()) as { charter: { entries: Array<{ id: string }> } };
    expect(charter.entries.map((e) => e.id)).toEqual(['c']);
  });

  it('a member may read the charter but not write it', async () => {
    const { project } = await seed();
    const { token } = await seedNonAdminMember(project);
    expect((await call(`/api/projects/${project.id}/divergence-charter`, token)).status).toBe(200);

    const write = await call(`/api/projects/${project.id}/divergence-charter`, token, {
      method: 'PUT',
      body: JSON.stringify({ entries: [entry('a', 'one')] }),
    });
    expect(write.status).toBe(403);
  });
});

describe('postman write-target — replaces forge_postman_target', () => {
  it('reports not-configured when the project has no active postman binding', async () => {
    const { project, token } = await seed();
    const res = await call(`/api/projects/${project.id}/integrations/postman-target`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});

describe('release batch lifecycle — replaces forge_release_batch', () => {
  async function seedBatchRun(projectId: string) {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running',
              ${JSON.stringify({ source: 'release-batch' })}::jsonb)
    `);
    return runId;
  }

  it('loads the batch context for a run that belongs to the project in the path', async () => {
    const { project, token } = await seed();
    const runId = await seedBatchRun(project.id);

    const res = await call(`/api/projects/${project.id}/release-batches/${runId}`, token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { projectId: string }).toMatchObject({ projectId: project.id });
  });

  // cm:guard this is the case the MCP tool could not have: it read the project OFF the run, so a mismatch was impossible. A project-scoped URL makes it possible, and the PAT fence bites on the path id alone — so without this refusal a token scoped to one project finishes another project's release.
  it('refuses a runId that belongs to a different project than the path names', async () => {
    const mine = await seed();
    const theirs = await seed();
    const runId = await seedBatchRun(theirs.project.id);

    const res = await call(`/api/projects/${mine.project.id}/release-batches/${runId}`, mine.token);
    expect(res.status).toBe(404);

    const finish = await call(
      `/api/projects/${mine.project.id}/release-batches/${runId}/finish`,
      mine.token,
      { method: 'POST', body: '{}' },
    );
    expect(finish.status).toBe(404);
  });

  it('abort releases the claims and closes nothing', async () => {
    const { user, project, token } = await seed();
    const runId = await seedBatchRun(project.id);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_batch_run_id)
      VALUES (${issueId}, ${project.id}, 1, 'Shipped thing', 'tested', ${user.id}, ${runId})
    `);

    const res = await call(`/api/projects/${project.id}/release-batches/${runId}/abort`, token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'deploy did not land' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { releasedIds: string[] }).toMatchObject({
      aborted: true,
      releasedIds: [issueId],
    });

    const after = await harness.db.execute(
      sql`SELECT status, release_batch_run_id FROM issues WHERE id = ${issueId}`,
    );
    expect(after[0]).toMatchObject({ status: 'tested', release_batch_run_id: null });
  });
});

describe('ux-improver — the REST route the deleted tool duplicated', () => {
  it('reads candidates as a member and refuses to propose as one', async () => {
    const { project } = await seed();
    const { token } = await seedNonAdminMember(project);
    const candidates = await call(`/api/projects/${project.id}/ux-improver/candidates`, token);
    expect(candidates.status).toBe(200);

    const propose = await call(`/api/projects/${project.id}/ux-improver/propose`, token, {
      method: 'POST',
      body: JSON.stringify({ keys: [] }),
    });
    expect(propose.status).toBe(403);
  });

  it('an admin proposing nothing still succeeds — that call is what refreshes the inbox', async () => {
    const { project, token } = await seed();
    const res = await call(`/api/projects/${project.id}/ux-improver/propose`, token, {
      method: 'POST',
      body: JSON.stringify({ keys: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { outcomes: unknown[] }).toEqual({ outcomes: [] });
  });
});

describe('GET /api/me/collaborators', () => {
  it('returns the people a caller shares projects with, and their roles', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ email: string; memberships: Array<{ projectId: string; role: string }> }>;
    };
    const found = body.users.find((u) => u.email === mate.user.email);
    expect(found?.memberships).toEqual([
      expect.objectContaining({ projectId: project.id, role: 'member' }),
    ]);
  });

  // cm:guard the whole surface of this route is OTHER PEOPLE's user rows, and `users` carries `passwordHash` on the same row — so a projection that ever became a `select()` would answer a people-search with credentials. Assert the absence by name rather than trusting the service's own guard, because this is the route that exposes it.
  it('never returns an auth secret', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const raw = await res.text();
    for (const secret of ['passwordHash', 'password_hash', 'tokenHash']) {
      expect(raw).not.toContain(secret);
    }
  });

  // cm:guard the seed is load-bearing: with no `project_members` row anywhere this route answers `{users:[],total:0}` however broken the scoping is, so an unseeded version of this case cannot fail. And `listCollaborators` guards a zero-visibility caller TWICE over — the early return and the `inArray` on the candidate query — each sufficient alone, so deleting either one changes nothing and this stays green. Measured both ways. That means a green here is NOT evidence a given line is dead; it takes both gone before the stranger is handed another account's row.
  it('shows nobody to a caller who shares no project', async () => {
    const owner = await verifiedUser();
    const project = await createTestProject(harness.db, owner.user.id);
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'member',
    });
    const stranger = await verifiedUser();

    const res = await app.request('/api/me/collaborators', {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { users: unknown[] }).toEqual({ users: [], total: 0 });
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await app.request('/api/me/collaborators')).status).toBe(401);
  });
});

describe('PUT /api/projects/:projectId/skills/:skillId/pin', () => {
  async function seedProjectSkill(projectId: string) {
    const skillId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO skills (id, project_id, scope, name, description, prompt, source,
                          content_hash, skill_md)
      VALUES (${skillId}, ${projectId}, 'project', ${`s-${skillId.slice(0, 8)}`},
              'fixture', 'p', 'manual', ${skillId}, '# body')`);
    return skillId;
  }

  it('pins with a reason and records who declared the divergence', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'tenant-specific wording, never rebase' }),
    });
    expect(res.status).toBe(200);

    const row = await harness.db.execute(
      sql`SELECT pinned, pinned_reason, pinned_by FROM skills WHERE id = ${skillId}`,
    );
    expect(row[0]).toMatchObject({
      pinned: true,
      pinned_reason: 'tenant-specific wording, never rebase',
    });
    expect((row[0] as { pinned_by: string | null }).pinned_by).not.toBeNull();
  });

  // cm:guard the reason is refused HERE, by the schema, and the service ALSO throws — assert the 400 rather than the throw, because the service signals with a raw `Error` whose message starts `BAD_REQUEST:` and that reaches a caller as a 500. A pin with no reason is a permanent divergence nobody can account for later.
  it('refuses a pin with no reason, as a 400 and not a 500', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(400);
  });

  it('unpins without a reason and clears what the pin recorded', async () => {
    const { project, token } = await seed();
    const skillId = await seedProjectSkill(project.id);
    await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'because' }),
    });

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: false }),
    });
    expect(res.status).toBe(200);
    const row = await harness.db.execute(
      sql`SELECT pinned, pinned_reason, pinned_by, pinned_at FROM skills WHERE id = ${skillId}`,
    );
    expect(row[0]).toMatchObject({ pinned: false, pinned_reason: null, pinned_by: null });
  });

  it('refuses a member who is not an admin', async () => {
    const { project } = await seed();
    const skillId = await seedProjectSkill(project.id);
    const { token } = await seedNonAdminMember(project);

    const res = await call(`/api/projects/${project.id}/skills/${skillId}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  // cm:guard a skill that exists but belongs elsewhere must answer 404, not 500 — the UPDATE is keyed on (id, projectId) so it matches nothing and the service throws a raw `NOT_FOUND:` Error. 404 is also what stops the route being used to probe which skill ids exist in projects the caller cannot see.
  it('answers 404 for a skill that belongs to another project', async () => {
    const { project, token } = await seed();
    const other = await seed();
    const foreignSkill = await seedProjectSkill(other.project.id);

    const res = await call(`/api/projects/${project.id}/skills/${foreignSkill}/pin`, token, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true, reason: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
