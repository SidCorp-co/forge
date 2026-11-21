/**
 * A release closes what it claimed only where no live criterion fails this round (ISS-1397). Planted
 * from FB-806: adminhub-api's release record 0.31.0 closed all four issues it carried, ISS-256 among
 * them with criterion 3's newest verdict a fail, asking no `unmet` and refusing nothing.
 *
 * - a release record over such an issue leaves it at `awaiting_release`, named in the record's
 *   `failed` with the criterion and the way on, while the rest of its roster closes;
 * - a finished batch closes through the same move, and leaves it the same way;
 * - an issue whose criteria are open, passing, or failed before its latest reopen still closes.
 *
 * @direct-test-of packages/core/src/issues/release-close-failing.ts
 * @direct-test-of packages/core/src/issues/close-in-scope.ts
 * @direct-test-of packages/core/src/release-batch/recorded.ts
 * @direct-test-of packages/core/src/release-batch/close-roster.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const LIVE = {
  live: {
    tier: 'production' as const,
    deployment: { mode: 'external' as const, target: 'adminhub-deploy' },
  },
};
const SHA = 'cd34'.repeat(10);
const NOTE = JSON.stringify({
  section: 'Changed',
  title: 'Orders list the store',
  userFacing: 'Orders now list the store they came from.',
});

let projectId = '';
let ownerId = '';
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, { environments: LIVE, defaultBranch: 'main' });
  call = requester(app, { owner: await userToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 250;
/** An issue its run landed, at `awaiting_release` with its merge and release note recorded. */
async function landed(criteria: string[]): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, release_notes)
    VALUES (${id}, ${projectId}, ${seq}, ${`adminhub work ${seq}`}, 'awaiting_release', ${ownerId}, now(), ${SHA}, ${NOTE}::jsonb)`);
  for (const [i, statement] of criteria.entries()) {
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})`);
  }
  return id;
}

async function judged(issueId: string, n: number, verdict: 'pass' | 'fail'): Promise<void> {
  await rows(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, author_agency, identity_kind, commit_sha)
    SELECT id, issue_id, ${verdict}, ${`${verdict} on the build`}, 'agent', 'commit', ${SHA}
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL`);
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const recordRelease = async (issueIds: string[], version: string) =>
  ok(
    await call('owner', 'POST', `/api/projects/${projectId}/release-records`, {
      issueIds,
      version,
      account: `adminhub-api ${version} deployed by its own pipeline; read live at /health.`,
    }),
    201,
  ) as { closed: string[]; failed: Array<{ id: string; reason: string }> };

describe('a release closes no issue over a failing criterion (ISS-1397)', () => {
  it('leaves an issue whose criterion fails at awaiting_release, named in the record with the way on', async () => {
    const failing = await landed(['orders list the store', 'orders sort by store', 'it pages']);
    await judged(failing, 1, 'pass');
    await judged(failing, 2, 'fail');
    const met = await landed(['stores list their orders']);

    const r = await recordRelease([failing, met], '0.31.0');

    expect(r.closed).toEqual([met]);
    expect(r.failed.map((f) => f.id)).toEqual([failing]);
    const reason = r.failed[0]?.reason ?? '';
    expect(reason).toContain("criterion 2's newest verdict is a fail");
    expect(reason).not.toContain('criterion 1');
    expect(reason).toContain('waits at `awaiting_release`');
    expect(reason).toContain('`unmet`');
    expect(reason).toContain('judge it again to a pass');
    expect(await statusOf(failing)).toBe('awaiting_release');
    expect(await statusOf(met)).toBe('closed');
  });

  it('leaves it the same way when a finished batch closes its roster', async () => {
    const failing = await landed(['orders list the store', 'orders sort by store']);
    await judged(failing, 2, 'fail');
    const runId = randomUUID();
    await rows(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running', now(), '0.32.0',
              ${JSON.stringify({ source: 'release-batch', issueIds: [failing] })}::jsonb)`);
    await rows(sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${failing}`);
    const { closeRoster } = await import('../../src/release-batch/close-roster.js');
    const { accountActor } = await import('../../src/issues/index.js');

    const batch = await closeRoster(
      [{ id: failing, status: 'awaiting_release', reopenCount: 0, projectId }],
      runId,
      await accountActor(ownerId),
      undefined,
    );

    expect(batch.closed).toEqual([]);
    expect(batch.failed[0]?.reason).toContain("criterion 2's newest verdict is a fail");
    expect(await statusOf(failing)).toBe('awaiting_release');
  });

  it('still closes an issue whose criteria are open, passing, or failed before its latest reopen', async () => {
    const id = await landed(['orders list the store', 'orders sort by store', 'it pages']);
    await judged(id, 1, 'pass');
    await judged(id, 3, 'fail');
    // the reopen rejected the build criterion 3 failed on: the fix ships to be judged anew
    await rows(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES ('issue', ${id}, 'awaiting_release', 'reopen', 'system', 'agent', 'fixture', clock_timestamp())`);

    const r = await recordRelease([id], '0.33.0');

    expect(r).toMatchObject({ closed: [id], failed: [] });
    expect(await statusOf(id)).toBe('closed');
  });
});
