/**
 * The world the merge suites run in: a GitLab-bound project whose document lands on
 * `release/stg`, its issues and stored merge requests, and the host's report of a merge as its hook
 * emits one. The planted host is `planted-gitlab-merges.ts`'s; each suite mocks the resolver onto it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { emitEvent } from '../../src/outbox/index.js';
import { api, userToken } from './api.js';
import { settleOutbox } from './ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from './factories.js';
import { heads, mergeMessage, messages, resetPlanted } from './planted-gitlab-merges.js';
import { seedProjectDocument } from './release-world.js';

export const BRANCH = 'release/stg';
const NOTE = { section: 'Added', userFacing: 'A site writes through to the catalog.' };

export const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

export const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

/** `extra` adds project-document keys beside `delivery` and `release`, such as a suite's `gates`. */
export async function seedWorld(
  release: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await truncateAll();
  resetPlanted();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: { repository: 'gitlab.com/acme/canawan-api', defaultBranch: BRANCH, branches: [BRANCH] },
    },
    extra: {
      delivery: { verdictsRequired: false },
      ...(release ? { release } : {}),
      ...extra,
    } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/canawan-api' })}::jsonb)
  `);
}

/** An issue at `status`, its release note written; `stamp` writes a local merge with no commit. */
export async function issue(seq: number, status: string, stamp = false): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  if (stamp) await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
  await seedIssueStatus(id, status);
  return id;
}

/** A merge request as the GitLab hook delivers it into the projection. */
export async function mergeRequest(
  number: number,
  headRef: string,
  head: string,
  body: string | null,
) {
  heads.set(number, headRef);
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: `MR ${number}`,
        body,
        html_url: `https://gitlab.com/acme/canawan-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: headRef, sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
}

export const issueRow = async (id: string) =>
  (
    await rows<{
      status: string;
      merged_at: Date | null;
      merged_commit_sha: string | null;
      merged_target: string | null;
      merged_head: { sha: string; treeIdentical: boolean | null; why: string | null } | null;
    }>(sql`
      SELECT status, merged_at, merged_commit_sha, merged_target, merged_head FROM issues WHERE id = ${id}`)
  )[0];

export const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

/** GitLab's report that it merged the request on `headRef` at `commitSha`, as its hook emits it. */
export async function hostMerged(
  number: number,
  headRef: string,
  commitSha: string,
  mergedAt = '2026-10-23T10:00:00.000Z',
) {
  // a commit GitLab made for another request keeps that request's message
  if (!messages.has(commitSha)) messages.set(commitSha, mergeMessage(number, headRef));
  await db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${commitSha}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);
  await emitEvent(db, 'source.merged', {
    projectId: world.projectId,
    headRef,
    baseRef: BRANCH,
    commitSha,
    mergedAt,
    head: null,
  });
  await settleOutbox();
}

/**
 * The landing an observed merge leaves on an issue, written as Forge's own merge route writes it, for
 * a suite whose subject is what comes after it: the host's report writes none (ISS-774).
 */
export async function stampObserved(id: string, commitSha: string, mergedAt: string) {
  await db.execute(sql`
    UPDATE issues SET merged_at = ${mergedAt}::timestamptz, merged_commit_sha = ${commitSha},
                      merged_target = ${BRANCH}
     WHERE id = ${id}`);
}
