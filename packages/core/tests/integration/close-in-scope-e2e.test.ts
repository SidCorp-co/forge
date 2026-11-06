/**
 * An issue closes when its criteria are met in scope (ADR 0014; owner, 2026-11-07). Planted from the
 * catalog-api board of 2026-11-06: 59 issues met in scope stood at `awaiting_release`, because only a
 * release could close one (`CLOSE_ONLY_BY_RELEASE`), and every reader took `closed` for live.
 *
 * - the run holding an issue closes it from `awaiting_release` with no release, its merge recorded;
 * - a close leaving a criterion it did not meet with no destination is refused by name, naming the
 *   criterion and the three places it may go;
 * - a close naming a destination for each moves each one out on the record first, and each
 *   destination holds its criterion;
 * - a release still closes an issue it claims, and only a release makes the work read live: the
 *   issue's shippedIn, the forecast's progress and shipped leg (which Activity and the
 *   progress-by-requirement report read), a requirement's work counts, and the development
 *   overview's shipped per module each read an issue its holder closed as not live.
 *
 * @direct-test-of packages/core/src/issues/close-in-scope.ts
 * @direct-test-of packages/core/src/issues/transition-guards.ts
 * @direct-test-of packages/core/src/issues/apply-transition.ts
 * @direct-test-of packages/core/src/issues/transition-body.ts
 * @direct-test-of packages/core/src/issues/merged-at.ts
 * @direct-test-of packages/core/src/issues/release-evidence.ts
 * @direct-test-of packages/core/src/pipeline/release-runs.ts
 * @direct-test-of packages/core/src/forecast/scope.ts
 * @direct-test-of packages/core/src/forecast/progress.ts
 * @direct-test-of packages/core/src/product-progress/progress.ts
 * @direct-test-of packages/core/src/development/overview-read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  completeIssueReadyRecord,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const LIVE = {
  live: {
    tier: 'production' as const,
    deployment: { mode: 'external' as const, target: 'catalog-deploy' },
  },
};
const SHA = 'ab12'.repeat(10);

let projectId = '';
let ownerId = '';
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

async function boxPat(userId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const deviceId = await createTestDevice(userId);
  return (await mintPat({ permissions: ['*'], userId, name, deviceId, projectIds: [projectId] }))
    .plaintext;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, { environments: LIVE, defaultBranch: 'main' });
  // two member agents' boxes, as pool runners are: neither holds project.admin to move past a holder
  const holder = (await createTestUser({ kind: 'agent' })).id;
  const other = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, holder, 'member');
  await addProjectMember(projectId, other, 'member');
  call = requester(app, {
    holder: await boxPat(holder, 'box-holder'),
    other: await boxPat(other, 'box-other'),
    owner: await userToken(ownerId),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 300;
/** An issue its run landed: at `status` with its merge recorded, and `criteria` as its live rows. */
async function landed(
  criteria: string[],
  status = 'awaiting_release',
): Promise<{ id: string; key: string }> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${id}, ${projectId}, ${seq}, ${`catalog work ${seq}`}, ${status}, ${ownerId}, now(), ${SHA})`);
  for (const [i, statement] of criteria.entries()) {
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})`);
  }
  return { id, key: `ISS-${seq}` };
}

/** The holder's box claims the issue: the lease its close then works under. */
async function lease(id: string, who = 'holder'): Promise<void> {
  ok(
    await call(who, 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        lease: { holder: `catalog-master-${who}`, renewedAt: new Date().toISOString(), minutes: 60 },
      },
    }),
  );
}

const close = (id: string, extra: Doc = {}, who = 'holder') =>
  call(who, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed', ...extra });

async function failVerdict(issueId: string, n: number): Promise<void> {
  await rows(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, author_agency)
    SELECT id, issue_id, 'fail', 'not met on the build', 'agent'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL`);
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const refusalsOf = (r: Reply): Array<{ code: string; detail: string }> => {
  const e = (r.json as { error?: { code?: string; detail?: string; refusals?: unknown[] } }).error;
  return (e?.refusals as Array<{ code: string; detail: string }> | undefined) ?? [
    { code: e?.code ?? '', detail: e?.detail ?? '' },
  ];
};

async function liveOf(id: string) {
  const { shippedReleasesOf } = await import('../../src/pipeline/release-runs.js');
  return (await shippedReleasesOf(projectId, [id])).get(id) ?? null;
}

describe('an issue closes when met in scope (ISS-1062)', () => {
  it('closes by the run holding it, with no release, and reads not live', async () => {
    const { id } = await landed(['the catalog lists the new field']);
    await lease(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await statusOf(id)).toBe('closed');
    const [row] = await rows<{ release_batch_run_id: string | null }>(
      sql`SELECT release_batch_run_id FROM issues WHERE id = ${id}`,
    );
    expect(row?.release_batch_run_id).toBeNull();
    expect(await liveOf(id)).toBeNull();
  });

  it('refuses a close by a run that does not hold it, NOT_THE_HOLDER naming the release door too', async () => {
    const { id } = await landed(['the catalog lists the new field']);
    await lease(id);
    const r = await close(id, {}, 'other');
    expect(r.status).toBe(403);
    const [first] = refusalsOf(r);
    expect(first?.code).toBe('NOT_THE_HOLDER');
    expect(first?.detail).toContain('met in scope');
    expect(first?.detail).toContain('release-records');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('refuses a close leaving a failed criterion with no destination, by name, with the three destinations', async () => {
    const { id } = await landed(['the field is listed', 'the field is sortable']);
    await failVerdict(id, 2);
    await lease(id);
    const r = await close(id);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    const [first] = refusalsOf(r);
    expect(first?.code).toBe('CLOSE_CRITERION_UNPLACED');
    expect(first?.detail).toContain('criterion 2: its newest verdict is a fail');
    expect(first?.detail).toContain('an issue the next batch works');
    expect(first?.detail).toContain('a new issue filed for it first');
    expect(first?.detail).toContain('the requirement the issue serves');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('refuses a criterion the closer names unmet with no destination, and one sent to a frozen issue', async () => {
    const { id } = await landed(['the field is listed', 'the field is sortable']);
    const { key: frozen } = await landed(['another landed outcome']);
    await lease(id);
    const bare = await close(id, { unmet: [{ criterion: 2 }] });
    expect(refusalsOf(bare)[0]?.detail).toContain('criterion 2: it names no destination');
    const toFrozen = await close(id, { unmet: [{ criterion: 2, to: { issue: frozen } }] });
    expect(refusalsOf(toFrozen)[0]?.code).toBe('CLOSE_CRITERION_UNPLACED');
    expect(refusalsOf(toFrozen)[0]?.detail).toContain(`${frozen} is \`awaiting_release\``);
    const unknown = await close(id, { unmet: [{ criterion: 7, to: { issue: frozen } }] });
    expect(refusalsOf(unknown)[0]?.detail).toContain('criterion 7: it is not a live criterion');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('moves each unmet criterion to its destination before it closes, and each destination holds it', async () => {
    const { id, key } = await landed([]);
    // criterion 1 traced to BC-1 of a requirement the issue serves, then two of its own
    const reqSeq = seq;
    const { requirementId } = await completeIssueReadyRecord(projectId, ownerId, id, reqSeq);
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, 2, 'the field is listed', 1), (${id}, 3, 'the field is sortable', 2)`);
    const next = await landed(['the next batch keeps its own'], 'open');
    await failVerdict(id, 3);
    await lease(id);
    const r = await close(id, {
      unmet: [
        { criterion: 3, to: { issue: next.key } },
        { criterion: 1, to: 'requirement' },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.movedOut).toEqual([
      `criterion 3 → ${next.key} criterion 2`,
      `criterion 1 → REQ-${reqSeq} BC-1, which holds it`,
    ]);
    expect(await statusOf(id)).toBe('closed');

    const taken = await rows<{ n: number; statement: string; retired_at: unknown }>(sql`
      SELECT n, statement, retired_at FROM issue_criteria WHERE issue_id = ${next.id} ORDER BY n`);
    expect(taken.map((c) => [c.n, c.statement, c.retired_at])).toEqual([
      [1, 'the next batch keeps its own', null],
      [2, 'the field is sortable', null],
    ]);
    const [text] = await rows<{ acceptance_criteria: string }>(
      sql`SELECT acceptance_criteria FROM issues WHERE id = ${next.id}`,
    );
    expect(text?.acceptance_criteria).toBe(
      '1. the next batch keeps its own\n2. the field is sortable',
    );

    const moved = await rows<{
      n: number;
      retired: boolean;
      to_criterion: string | null;
      to_requirement: string | null;
    }>(sql`
      SELECT n, retired_at IS NOT NULL AS retired, moved_to_criterion_id AS to_criterion,
             moved_to_requirement_id AS to_requirement
        FROM issue_criteria WHERE issue_id = ${id} ORDER BY n`);
    expect(moved.find((c) => c.n === 1)).toMatchObject({
      retired: true,
      to_requirement: requirementId,
    });
    expect(moved.find((c) => c.n === 3)?.retired).toBe(true);
    expect(moved.find((c) => c.n === 3)?.to_criterion).not.toBeNull();
    expect(moved.find((c) => c.n === 2)).toMatchObject({ retired: false, to_criterion: null });

    const notices = await rows<{ issue_id: string; body: string }>(sql`
      SELECT issue_id, body FROM comments WHERE issue_id IN (${id}, ${next.id}) ORDER BY created_at`);
    expect(notices.find((c) => c.issue_id === id)?.body).toContain(
      `criterion 3 → ${next.key} criterion 2`,
    );
    expect(notices.find((c) => c.issue_id === next.id)?.body).toBe(
      `Criterion 2 came from ${key} criterion 3, which closed without meeting it.`,
    );
  });

  it('refuses `unmet` on a move that is no close', async () => {
    const { id } = await landed(['the field is listed']);
    const r = await call('owner', 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'on_hold',
      reason: 'waiting on the catalog owner',
      unmet: [{ criterion: 1, to: 'requirement' }],
    });
    expect(refusalsOf(r)[0]?.code).toBe('UNMET_NOT_APPLICABLE');
  });

  it('still closes an issue a release claims, nobody holding it, and only the release makes it live', async () => {
    const { id } = await landed(['the catalog lists the new field']);
    ok(
      await call('owner', 'POST', `/api/projects/${projectId}/release-records`, {
        issueIds: [id],
        version: '3.1.0',
        account: 'catalog-api 3.1.0 deployed by its own pipeline; read live at /health.',
      }),
      201,
    );
    expect(await statusOf(id)).toBe('closed');
    expect((await liveOf(id))?.version).toBe('3.1.0');
  });

  it('keeps the database refusing a close with no recorded merge, its message saying what closed means now', async () => {
    const { id } = await landed(['the field is listed'], 'open');
    await rows(sql`UPDATE issues SET merged_at = NULL, merged_commit_sha = NULL WHERE id = ${id}`);
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    const said = await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
    ).then(
      () => 'written',
      (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
    );
    expect(said).toMatch(
      /cannot enter `closed` with no merged_at\. `closed` means its criteria were met in scope/,
    );
    expect(await statusOf(id)).toBe('open');
  });
});

describe('whether the work is live is read from the release record, never from closed (ISS-1062)', () => {
  const recordRelease = (ids: string[], version: string) =>
    call('owner', 'POST', `/api/projects/${projectId}/release-records`, {
      issueIds: ids,
      version,
      account: `catalog-api ${version} deployed by its own pipeline; read live at /health.`,
    });
  const shippedIn = async (id: string) =>
    (ok(await call('owner', 'GET', `/api/issues/${id}`)) as { shippedIn: unknown }).shippedIn;
  const looseShipped = async () => {
    const { readDevelopmentOverview } = await import('../../src/development/overview-read.js');
    return (await readDevelopmentOverview(projectId, null)).modules.unassigned.shipped;
  };

  it('reads an issue its holder closed as not live in every reader, and live once a release carries it', async () => {
    const { id } = await landed([]);
    const reqSeq = seq;
    await completeIssueReadyRecord(projectId, ownerId, id, reqSeq);
    const before = await looseShipped();
    await lease(id);
    ok(await close(id));
    expect(await statusOf(id)).toBe('closed');

    expect(await shippedIn(id)).toBeNull();
    const { readRequirementForecast } = await import('../../src/forecast/index.js');
    const forecast = await readRequirementForecast(projectId, reqSeq, null);
    expect(forecast?.progress).toEqual({ total: 1, shipped: 0, awaitingRelease: 1, toDo: 0 });
    expect(forecast?.delivery?.shipped ?? null).toBeNull();
    const { issuesOfRequirements } = await import('../../src/product-progress/progress.js');
    const [requirement] = await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${reqSeq}`,
    );
    const work = (await issuesOfRequirements(projectId, [requirement?.id ?? ''])).get(
      requirement?.id ?? '',
    );
    expect(work?.map((w) => [w.status, w.released])).toEqual([['closed', false]]);
    expect(await looseShipped()).toBe(before);
  });

  it('never revives a release its reopen rejected when the holder closes the issue again', async () => {
    const { id } = await landed(['the catalog lists the new field']);
    ok(await recordRelease([id], '3.2.0'), 201);
    expect(await shippedIn(id)).toMatchObject({ version: '3.2.0' });
    ok(
      await call('owner', 'POST', `/api/issues/${id}/transition`, {
        toStatus: 'reopen',
        reason: 'the field is missing on the live catalog',
      }),
    );
    expect(await shippedIn(id)).toBeNull();
    // landed again, its run takes it to the gate and closes it met in scope; no release follows yet
    await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
    await lease(id);
    ok(await call('holder', 'POST', `/api/issues/${id}/transition`, { toStatus: 'in_progress' }));
    ok(
      await call('holder', 'POST', `/api/issues/${id}/transition`, {
        toStatus: 'awaiting_release',
      }),
    );
    ok(await close(id));
    expect(await statusOf(id)).toBe('closed');
    expect(await shippedIn(id)).toBeNull();
  });
});
