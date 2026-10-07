/**
 * ISS-1337 — a release on a project whose production deploy is a person's says, before the press,
 * which rows its finish could not close.
 *
 * Measured on mowment, batch d3993d45: a press claimed four rows, the finish refused every close
 * (three for want of a landing mark, one for an open question), and the board read as it did before
 * the press. The world here is that project's shape — work landing outside git, a one-entry
 * `publish` chain, a live binding declaring no probe, no automatic release — with four rows at the
 * gate: one with no landing, one holding an open question, one missing the record this project
 * declares for `closed`, and one whose close stands. Real Postgres and the real route mount.
 */

import { randomUUID } from 'node:crypto';
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
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const LANDING = 'https://mowmentbrand.com/products/classic-baseball-button-jersey';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let token: string;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [batch, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (
    await createTestProject(harness.db, ownerId, {
      agentConfig: { pipelineConfig: { statusEntryCriteria: { closed: ['plan'] } } },
    })
  ).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await harness.db.execute(sql`UPDATE projects SET kind = 'website' WHERE id = ${projectId}`);
  await fx.declareProduction();
  // A person's deploy: one `publish` entry, and nothing that reads what production serves.
  await harness.db.execute(sql`
    UPDATE projects SET release_chain = '[{"branch": "main"}]'::jsonb WHERE id = ${projectId}
  `);
  await harness.db.execute(sql`
    UPDATE integration_bindings SET config = config - 'verify' WHERE project_id = ${projectId}
  `);
  await fx.seedReleaseRunner();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(ownerId);
});

/** A row at the gate whose close stands: a landing named and the declared plan written. */
async function closable(): Promise<string> {
  const id = await fx.insertIssue();
  await harness.db.execute(sql`
    UPDATE issues SET merged_landing = ${LANDING}, plan = 'the plan' WHERE id = ${id}
  `);
  return id;
}

async function askOn(issueId: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', 'human', '[{"round":1}]'::jsonb)
  `);
  return id;
}

/** The four rows the measurement had the shapes of, in roster order. */
async function fourRows() {
  const clean = await closable();
  const unmarked = await closable();
  await harness.db.execute(sql`UPDATE issues SET merged_landing = NULL WHERE id = ${unmarked}`);
  const asked = await closable();
  await askOn(asked);
  const unplanned = await closable();
  await harness.db.execute(sql`UPDATE issues SET plan = NULL WHERE id = ${unplanned}`);
  return { clean, unmarked, asked, unplanned };
}

function get(path: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function runCount(): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${projectId}
  `);
  return Number(rows[0]?.n ?? 0);
}

describe('a release names, before the press, the rows its finish could not close', () => {
  it('names each unclosable row on the roster, with its reason and what clears it', async () => {
    const rows = await fourRows();

    const res = await get(`/api/projects/${projectId}/release-batches/roster`);
    expect(res.status).toBe(200);
    const roster = (await res.json()) as {
      issues: Array<{ id: string; closeRefusals: Array<Record<string, string>> }>;
    };
    const refusalsOf = (id: string) => roster.issues.find((i) => i.id === id)?.closeRefusals;

    expect(refusalsOf(rows.clean)).toEqual([]);
    expect(refusalsOf(rows.unmarked)).toEqual([
      expect.objectContaining({
        code: 'CLOSE_REQUIRES_SHIPPED',
        reason: 'no mark naming where its work landed',
        clears: expect.stringContaining('landing'),
      }),
    ]);
    expect(refusalsOf(rows.asked)).toEqual([
      expect.objectContaining({
        code: 'OPEN_QUESTIONS',
        reason: 'holds 1 open question',
        clears: expect.stringContaining('Answer it'),
      }),
    ]);
    expect(refusalsOf(rows.unplanned)).toEqual([
      expect.objectContaining({
        code: 'ENTRY_CRITERIA_UNMET',
        reason: 'missing what this project requires to close: plan',
        clears: 'Write each missing record on the issue.',
      }),
    ]);
  });

  it('refuses a press naming them with a 409 naming each, and claims nothing and opens no run', async () => {
    const rows = await fourRows();
    const [unmarkedKey, askedKey, unplannedKey] = await fx.displayIds([
      rows.unmarked,
      rows.asked,
      rows.unplanned,
    ]);

    const res = await post(`/api/projects/${projectId}/release-batches`, {
      issueIds: [rows.clean, rows.unmarked, rows.asked, rows.unplanned],
    });

    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('RELEASE_WORK_UNMERGED');
    expect(body).toContain(String(unmarkedKey));
    expect(body).toContain('RELEASE_ISSUES_UNCLOSABLE');
    expect(body).toContain(`\`${askedKey}\` holds 1 open question`);
    expect(body).toContain(`\`${unplannedKey}\` missing what this project requires to close: plan`);
    for (const id of Object.values(rows)) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
    expect(await runCount()).toBe(0);
  });

  it('lists the same refusal on release readiness before anyone presses', async () => {
    await fourRows();

    const res = await get(`/api/projects/${projectId}/release-readiness`);
    expect(res.status).toBe(200);
    const readiness = (await res.json()) as { blockers: Array<{ code: string; message: string }> };
    const codes = readiness.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_WORK_UNMERGED');
    expect(codes).toContain('RELEASE_ISSUES_UNCLOSABLE');
  });

  it('refuses a release record naming a row with an open question, and closes nothing', async () => {
    const { recordPerformedRelease } = await import('../../src/release-batch/recorded.js');
    const rows = await fourRows();
    const [askedKey] = await fx.displayIds([rows.asked]);

    const refusal = await recordPerformedRelease({
      projectId,
      issueIds: [rows.clean, rows.asked],
      commit: 'a'.repeat(40),
      account: 'published the store theme by hand from the admin screen',
      userId: ownerId,
    }).then(
      () => null,
      (err: unknown) =>
        err as Error & { releaseBlockers?: Array<{ code: string; message: string }> },
    );

    expect(refusal?.name).toBe('ReleaseIssuesUnclosableError');
    const unclosable = refusal?.releaseBlockers?.find(
      (b) => b.code === 'RELEASE_ISSUES_UNCLOSABLE',
    );
    expect(unclosable?.message).toContain(`\`${askedKey}\` holds 1 open question`);
    expect((await fx.stored(rows.clean)).status).toBe('awaiting_release');
    expect((await fx.stored(rows.asked)).status).toBe('awaiting_release');
  });
});

describe('a release still ships every row whose close stands', () => {
  it('closes a row whose close stands, saying as whoever finished that nothing read production', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const rows = await fourRows();

    const { runId } = await fx.claim([rows.clean], { deploy: false });
    const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect(result).toEqual({ closed: [rows.clean], failed: [] });
    expect((await fx.stored(rows.clean)).status).toBe('closed');
    const said = await harness.db.execute(sql`
      SELECT author_id, body FROM comments
       WHERE issue_id = ${rows.clean} AND body LIKE ${`%release-verification: unverified ${runId}%`}
    `);
    expect(said).toHaveLength(1);
    expect(said[0]?.author_id).toBe(ownerId);
    expect(String(said[0]?.body)).toContain('nothing read the live deployment');
    for (const id of [rows.unmarked, rows.asked, rows.unplanned]) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
  });

  it('leaves the unclosable rows off a scheduled cut, cuts the rest, and names each one left off', async () => {
    const { runScheduledReleaseCut } = await import('../../src/schedules/release-batch-run.js');
    const rows = await fourRows();
    const [unmarkedKey, askedKey, unplannedKey] = await fx.displayIds([
      rows.unmarked,
      rows.asked,
      rows.unplanned,
    ]);

    const outcome = await runScheduledReleaseCut({ projectId, userId: ownerId });

    expect(outcome.status).toBe('success');
    expect(outcome.named).toEqual([rows.clean]);
    expect((await fx.stored(rows.clean)).status).toBe('releasing');
    expect(outcome.leftOff).toEqual([
      expect.stringMatching(new RegExp(`^${unmarkedKey}: no mark naming where its work landed`)),
      expect.stringMatching(new RegExp(`^${askedKey}: holds 1 open question`)),
      expect.stringMatching(new RegExp(`^${unplannedKey}: missing what this project requires`)),
    ]);
    expect(outcome.output).toContain('left off 3 issue(s)');
    for (const id of [rows.unmarked, rows.asked, rows.unplanned]) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
  });

  it('leaves the unclosable rows off the unattended sweep, holds each with why, and cuts the rest', async () => {
    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = jsonb_set(agent_config, '{pipelineConfig,autoProdDeploy}', 'true')
       WHERE id = ${projectId}
    `);
    const rows = await fourRows();

    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(1);
    expect((await fx.stored(rows.clean)).status).toBe('releasing');
    for (const id of [rows.unmarked, rows.asked, rows.unplanned]) {
      expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
      expect((await fx.holdOf(id))?.code).toBe('RELEASE_ISSUES_UNCLOSABLE');
    }
    expect(String((await fx.holdOf(rows.asked))?.reason)).toContain('holds 1 open question');
  }, 30_000);
});
