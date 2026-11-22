// The world of close-in-scope-e2e and its reopen twin: one project with a production environment,
// two member agents' boxes (holder, other) and the owner, and issues planted as their runs landed.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { userToken } from './api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from './ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from './factories.js';
import { seedProjectDocument } from './release-world.js';

const LIVE = {
  live: {
    tier: 'production' as const,
    deployment: { mode: 'external' as const, target: 'catalog-deploy' },
  },
};
const SHA = 'ab12'.repeat(10);

export let projectId = '';
export let ownerId = '';
export let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;

export async function boxPat(userId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const deviceId = await createTestDevice(userId);
  return (await mintPat({ permissions: ['*'], userId, name, deviceId, projectIds: [projectId] }))
    .plaintext;
}

/** Registers the world's setup and teardown in the importing test file. */
export function useCloseScopeWorld(): void {
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
}

export let seq = 300;
/** The note its run wrote before the close, as the close asks (ISS-1293). */
export const NOTE = JSON.stringify({
  section: 'Changed',
  title: 'The catalog lists the new field',
  userFacing: 'The catalog now lists the new field.',
});

/** An issue its run landed: at `status` with its merge and release note recorded, and `criteria` as its live rows. */
export async function landed(
  criteria: string[],
  status = 'awaiting_release',
): Promise<{ id: string; key: string }> {
  seq += 1;
  const id = randomUUID();
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, release_notes)
    VALUES (${id}, ${projectId}, ${seq}, ${`catalog work ${seq}`}, ${status}, ${ownerId}, now(), ${SHA}, ${NOTE}::jsonb)`);
  for (const [i, statement] of criteria.entries()) {
    await rows(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})`);
  }
  return { id, key: `ISS-${seq}` };
}

/** The holder's box claims the issue: the lease its close then works under. */
export async function lease(id: string, who = 'holder'): Promise<void> {
  ok(
    await call(who, 'PATCH', `/api/issues/${id}`, {
      sessionContext: {
        lease: {
          holder: `catalog-master-${who}`,
          renewedAt: new Date().toISOString(),
          minutes: 60,
        },
      },
    }),
  );
}

export const close = (id: string, extra: Doc = {}, who = 'holder') =>
  call(who, 'POST', `/api/issues/${id}/transition`, { toStatus: 'closed', ...extra });

export async function failVerdict(issueId: string, n: number): Promise<void> {
  await rows(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, author_agency)
    SELECT id, issue_id, 'fail', 'not met on the build', 'agent'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL`);
}

export const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

export const refusalsOf = (r: Reply): Array<{ code: string; detail: string }> => {
  const e = (r.json as { error?: { code?: string; detail?: string; refusals?: unknown[] } }).error;
  return (
    (e?.refusals as Array<{ code: string; detail: string }> | undefined) ?? [
      { code: e?.code ?? '', detail: e?.detail ?? '' },
    ]
  );
};

export async function liveOf(id: string) {
  const { shippedReleasesOf } = await import('../../src/pipeline/release-runs.js');
  return (await shippedReleasesOf(projectId, [id])).get(id) ?? null;
}
