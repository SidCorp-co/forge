/**
 * ISS-1421 — an issue reaches Releasing only through a release batch, and leaves it only through a
 * release path, whichever door asks.
 *
 * Measured on sid-desk: ten rows stood at Releasing for up to eight days with no batch behind them,
 * put there through the status picker one at a time. Every door that moves a status — REST
 * `/transition`, `PATCH /issues/batch`, `forge_issues` — is driven here with that move, and the
 * row is read back. A batch create is driven too: its roster enters Releasing
 * claimed by its run in one transaction, or none of it does and the run is cancelled. Real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();

  const [transitionMod, extrasMod, batchMod, jwtMod, patMod, errMod, issueMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/extras-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
    import('../../src/issues/routes.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', extrasMod.issueExtrasRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.route('/api/issues', issueMod.issueRoutes);
  app.route('/api/projects', batchMod.releaseBatchRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let projectId: string;
let ownerId: string;
let token: string;
let pat: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  ownerId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
  await createTestProjectMember(harness.db, { userId: user.id, projectId, role: 'admin' });
  token = await signUserToken(user.id);
  pat = (await mintPat({ userId: user.id, name: 'a door', boundProjectId: projectId })).plaintext;
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

async function row(id: string): Promise<{ status: string; claim: string | null }> {
  const rows = await harness.db.execute<{ status: string; claim: string | null }>(
    sql`SELECT status, release_batch_run_id AS claim FROM issues WHERE id = ${id}`,
  );
  return rows[0] as { status: string; claim: string | null };
}

async function movesInto(id: string, status: string): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${id} AND to_status = ${status}
  `);
  return Number(rows[0]?.n ?? 0);
}

async function plantRun(status: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${id}, ${projectId}, 'system', ${status}, '{"source":"release-batch"}'::jsonb)
  `);
  return id;
}

async function plantIssue(
  status: string,
  claim: string | null = null,
  merged = true,
): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, merged_at, release_batch_run_id)
    VALUES (${projectId}, 'the subject', ${ownerId}, ${status}, ${merged ? sql`now()` : null}, ${claim})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

const rest = (id: string, body: Record<string, unknown>) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function batch(ids: string[], data: Record<string, unknown>) {
  const res = await app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, data }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    updated: Array<{ id: string }>;
    skipped: Array<{
      id: string;
      reason: string;
      code?: string;
      message?: string;
      detail?: string;
    }>;
  };
}

async function mcp(args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat, null);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_issues', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
  } finally {
    await ctx.close();
  }
}

describe('a move to Releasing from any door but a release batch (criteria 5, 6, 7, 24)', () => {
  beforeEach(async () => {
    await fx.declareProduction();
  });

  it('is refused at REST /transition from Awaiting release, saying where a release starts', async () => {
    const id = await plantIssue('awaiting_release');
    const res = await rest(id, { toStatus: 'releasing' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(body.message).toContain(
      'Releasing means a release batch is carrying this issue to production right now',
    );
    expect(body.message).toContain("Release now on this issue's page or at the release gate");
    expect(body.message).toContain(`POST /api/projects/${projectId}/release-batches`);
    expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await movesInto(id, 'releasing')).toBe(0);
  });

  it('tells an issue at Awaiting release that is not marked merged to mark it, not to press Release now (criterion 38)', async () => {
    const id = await plantIssue('awaiting_release', null, false);
    const res = await rest(id, { toStatus: 'releasing' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(body.message).toContain(
      'A release cannot close this issue yet. It is not marked merged.',
    );
    expect(body.message).toContain(markMergedSteps(false));
    expect(body.message).toContain('Release now appears on its page once that is done.');
    expect(body.message).not.toContain('Start one with Release now');
    expect(body.message).not.toContain('release-batches');
    expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
  });

  for (const from of ['open', 'developed', 'testing', 'in_progress'] as const) {
    it(`is refused at REST /transition from ${from}, saying it must reach Awaiting release first`, async () => {
      const id = await plantIssue(from);
      const res = await rest(id, { toStatus: 'releasing' });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('RELEASING_STARTS_FROM_RELEASE');
      expect(body.message).toContain(
        'A release carries only issues at Awaiting release, so it must reach that first.',
      );
      expect(body.message).not.toContain('Release now');
      expect(await row(id)).toEqual({ status: from, claim: null });
      expect(await movesInto(id, 'releasing')).toBe(0);
    });
  }

  it('is refused issue by issue at PATCH /issues/batch with the same code and sentence, and moves none of them', async () => {
    const a = await plantIssue('awaiting_release');
    const b = await plantIssue('awaiting_release');
    const answer = await batch([a, b], { status: 'releasing' });

    expect(answer.updated).toEqual([]);
    for (const id of [a, b]) {
      const result = answer.skipped.find((r) => r.id === id);
      expect(result).toMatchObject({
        reason: 'releasing_starts_from_release',
        code: 'RELEASING_STARTS_FROM_RELEASE',
      });
      expect(result?.message).toContain(
        'Releasing means a release batch is carrying this issue to production right now',
      );
      expect(result?.message).toContain("Release now on this issue's page");
      expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
    }
  });

  it('carries the refusal sentence beside the note that nothing else was written (criterion 31)', async () => {
    const id = await plantIssue('testing');
    const answer = await batch([id], { status: 'releasing', priority: 'high' });

    expect(answer.skipped[0]).toMatchObject({
      reason: 'releasing_starts_from_release',
      code: 'RELEASING_STARTS_FROM_RELEASE',
    });
    expect(answer.skipped[0]?.message).toContain('so it must reach that first');
    expect(answer.skipped[0]?.detail).toContain('nothing else this update carried was written');
  });

  for (const action of ['transition', 'update'] as const) {
    it(`is refused at forge_issues ${action}, naming the code`, async () => {
      const id = await plantIssue('awaiting_release');
      const answer = await mcp({ action, documentId: id, data: { status: 'releasing' } });

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('RELEASING_STARTS_FROM_RELEASE');
      expect(answer.text).toContain("Release now on this issue's page");
      expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
    });
  }

  it('is refused at PATCH /api/issues/:id, which takes no status, naming where a status moves (criterion 23)', async () => {
    const id = await plantIssue('awaiting_release');
    const res = await app.request(`/api/issues/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'releasing' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: { formErrors: string[] };
    };
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).not.toMatch(/Unrecognized key/);
    expect(body.message).toContain('POST /api/issues/:id/transition');
    expect(body.details.formErrors).toContain(
      'An issue update never writes a status, so this one wrote nothing. A status moves through POST /api/issues/:id/transition, or `forge_issues` `transition`, and only starting a release puts an issue at Releasing.',
    );
    expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await movesInto(id, 'releasing')).toBe(0);
  });
});

describe('the refusal names only the doors this project has (criteria 25, 26)', () => {
  it('on a project that ships nothing, names the setting and no release door', async () => {
    const id = await plantIssue('awaiting_release');
    const res = await rest(id, { toStatus: 'releasing' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(body.message).toContain('This project ships nothing');
    expect(body.message).toContain(
      "To release them, choose a shape that releases under Shape & release in the project's settings.",
    );
    expect(body.message).not.toMatch(/Release now|release gate|release-batches/);
    expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('on a project declaring a release with no live deploy target, says none can start until one is added', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch": "main"}]'::jsonb
      WHERE id = ${projectId}
    `);
    const id = await plantIssue('awaiting_release');
    const res = await rest(id, { toStatus: 'releasing' });

    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(body.message).toContain(
      "No release can start until one is added in the project's Settings, on the Integrations tab. There, share a connection as Deploy target, with Live ticked.",
    );
    expect(body.message).not.toMatch(/Release now|release gate/);
    // ISS-1421 r4: the address that opens the place is carried, under this project's own slug.
    const [project] = (await harness.db.execute(
      sql`SELECT slug FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ slug: string }>;
    expect(body.message).toContain(
      `/projects/${project?.slug}/settings?tab=integrations&add=live-deploy-target.`,
    );
  });
});

describe('a move off Releasing from any door but a release path (criterion 11)', () => {
  const OFF = [
    { toStatus: 'closed' },
    { toStatus: 'reopen', reason: 'it never deployed' },
    { toStatus: 'on_hold', reason: 'pausing it' },
    { toStatus: 'needs_info', reason: 'who pressed this?' },
    { toStatus: 'awaiting_release' },
  ];

  it('is refused at REST /transition, naming the run that carries it, and the row stays put', async () => {
    const run = await plantRun('running');
    const id = await plantIssue('releasing', run);
    for (const body of OFF) {
      const res = await rest(id, body);
      expect(res.status, body.toStatus).toBe(409);
      const answer = (await res.json()) as { code: string; message: string };
      expect(answer.code).toBe('RELEASING_ENDS_BY_RELEASE');
      expect(answer.message).toContain(`/releases/${run}.`);
      expect(answer.message).not.toMatch(/\/api\/|release-batches/);
      expect(answer.message).toContain(
        'Its abort, or the recovery of a release that stopped or could not go on, returns it to the release gate.',
      );
      expect(await row(id)).toEqual({ status: 'releasing', claim: run });
    }
  });

  it('is refused at PATCH /issues/batch and at forge_issues', async () => {
    const run = await plantRun('running');
    const id = await plantIssue('releasing', run);

    const answer = await batch([id], { status: 'closed' });
    expect(answer.updated).toEqual([]);
    expect(answer.skipped[0]).toMatchObject({ id, reason: 'releasing_ends_by_release' });

    const tool = await mcp({ action: 'transition', documentId: id, data: { status: 'closed' } });
    expect(tool.isError).toBe(true);
    expect(tool.text).toContain('RELEASING_ENDS_BY_RELEASE');
    expect(await row(id)).toEqual({ status: 'releasing', claim: run });
  });
});

describe('the one door that writes Releasing: creating a release batch (criteria 8, 9, 10)', () => {
  beforeEach(async () => {
    await fx.declareProduction();
    await fx.seedReleaseRunner();
  });

  it('moves the whole roster to Releasing claimed by its run, each move recorded with its actor', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const { runId } = await fx.claim([a, b], { look: false });

    for (const id of [a, b]) {
      expect(await row(id)).toEqual({ status: 'releasing', claim: runId });
      const moved = await harness.db.execute<{ actor_id: string; actor_type: string }>(sql`
        SELECT actor_id, actor_type FROM kernel_transitions
        WHERE entity = 'issue' AND entity_id = ${id} AND to_status = 'releasing'
      `);
      expect(moved).toEqual([{ actor_id: ownerId, actor_type: 'user' }]);
    }
    expect(await fx.runStatus(runId)).toBe('running');
  });

  it('moves none of the roster, and cancels the run, when one issue cannot enter Releasing', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { statusEntryCriteria: { releasing: ['plan'] } },
      })}::jsonb WHERE id = ${projectId}
    `);
    const planned = await fx.insertIssue();
    const unplanned = await fx.insertIssue();
    await harness.db.execute(sql`UPDATE issues SET plan = 'a plan' WHERE id = ${planned}`);

    const res = await app.request(`/api/projects/${projectId}/release-batches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ issueIds: [planned, unplanned] }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RELEASE_ROSTER_REFUSED');
    expect(body.message).toContain(
      `Issue ${unplanned} could not enter Releasing (ENTRY_CRITERIA_UNMET`,
    );
    expect(body.message).toContain('no issue on this roster was claimed or moved');
    for (const id of [planned, unplanned]) {
      expect(await row(id)).toEqual({ status: 'awaiting_release', claim: null });
      expect(await movesInto(id, 'releasing')).toBe(0);
    }
    const runs = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM pipeline_runs
      WHERE project_id = ${projectId} AND metadata ->> 'source' = 'release-batch'
    `);
    expect(runs).toEqual([{ status: 'cancelled' }]);
  });
});
