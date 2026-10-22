/**
 * A project of release mode `none` for the landing tests (`release-batch/landed-build.ts`): its
 * document declares `release/stg` and no production environment, and its ancestry is answered by a
 * planted reader from adminhub-api's real `release/stg` history, standing in for the box that reads
 * the bare repository. Each test file mocks `shipped-earlier.js:ancestrySourceFor` onto `reader`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api, userToken } from './api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from './factories.js';
import { seedProjectDocument } from './release-world.js';

export { ASIDE, C1, D9, F4, LATER, reader } from './landed-history.js';

export const BRANCH = 'release/stg';
const NOTE = { section: 'Skip', userFacing: '-' };
const ACCOUNT = 'Merged into release/stg and judged on the box at that head by QA.';

/** The project, its admin and the admin's token, seeded fresh by `seedLandedWorld`. */
export const world = { projectId: '', ownerId: '', token: '' };

export async function seedLandedWorld(): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
  });
}

export async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/**
 * An issue with three criteria, its merge marked on `release/stg` naming `commit` (or none); `mark`
 * replaces the mark's body past `target`, as `forge-runner api` sends it with the paths it read.
 */
export async function landedIssue(
  seq: number,
  commit: string | null,
  statements: readonly string[] = [
    'One command builds the local test databases',
    'Two worktrees never share a database',
    'An unsafe host is refused before any change',
  ],
  mark?: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await replaceCriteria(
    id,
    statements.map((statement, i) => ({ n: i + 1, statement })),
  );
  await ok(
    api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      ...(mark ?? (commit ? { commit } : {})),
    }),
  );
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

/** QA's verdict on criterion `n`, at `commit`. */
export async function verdict(issueId: string, n: number, word: 'pass' | 'fail', commit: string) {
  const [criterion] = (await db.execute(sql`
    SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    VALUES (${criterion?.id}, ${issueId}, ${word}, ${`${word} on the box at ${commit}`}, 'commit',
            ${commit}, ${world.ownerId}, 'agent', 'qa')
  `);
}

export async function judgedAll(issueId: string, commit: string) {
  for (const n of [1, 2, 3]) await verdict(issueId, n, 'pass', commit);
}

export const record = (issueIds: string[], commit: string) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-records`, {
    issueIds,
    commit,
    account: ACCOUNT,
  });

export async function statusOf(issueId: string): Promise<string> {
  const [row] = (await db.execute(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ status: string }>;
  return row?.status ?? 'absent';
}

type Refused = { code?: string; error?: { refusals?: Array<{ code: string; detail: string }> } };
export const refusalsOf = (body: unknown) =>
  (body as Refused).error?.refusals ?? [{ code: (body as Refused).code ?? '', detail: '' }];
