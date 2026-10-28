/**
 * REQ-76 BC-8: on a yolo project an agent may change code first, and Forge records the issue and its
 * landing from the merge. A merge onto the project's base branch that delivers no issue files one
 * at `open`, titled from the change request and linked to it, its landing recorded from the merge
 * itself; a redelivery of the same merge files nothing more; and the master is owed its claim and
 * move to awaiting_release (`pipeline/wedge-landed.ts:landedWorkOwed`). Under standard
 * (`issue_before_code` enforced) the same merge records nothing, as before.
 *
 * @direct-test-of packages/core/src/issues/host-merge.ts
 * @direct-test-of packages/core/src/pipeline/wedge-landed.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  BRANCH,
  hostMerged,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const HEAD = 'a7'.repeat(20);
const LANDING = 'b8'.repeat(20);
const UNNAMED = 'feature/faster-search';

/** The project's gate profile, through the gates door with a reason, as a person sets it. */
async function profile(name: 'standard' | 'yolo'): Promise<void> {
  // the world seeds a GitHub check on a GitLab repository, which any write of the document refuses
  // (GATE_UNSUPPORTED); a GitLab project declares its pipeline
  await db.execute(sql`
    UPDATE project_config_documents
       SET document = jsonb_set(document, '{validation,gate}', '{"type":"gitlab-pipeline","name":"pipeline"}')
     WHERE project_id = ${world.projectId}`);
  const path = `/api/projects/${world.projectId}/gates`;
  const read = await api(world.token, 'GET', path);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const put = await api(world.token, 'PUT', path, {
    baseRevision: (read.body as { revision: number }).revision,
    profile: name,
    overrides: {},
    reason: `planted: ${name} for the merge-first test`,
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

const filed = () =>
  rows<{
    id: string;
    title: string;
    status: string;
    merged_commit_sha: string | null;
    merged_target: string | null;
    merged_at: Date | null;
    created_via: string;
  }>(sql`
    SELECT id, title, status, merged_commit_sha, merged_target, merged_at, created_via
      FROM issues WHERE project_id = ${world.projectId} AND detector_key = ${`merged/${LANDING}`}`);

const issueCount = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${world.projectId}`,
    )
  )[0]?.n;

describe('REQ-76 BC-8: a merge naming no issue', () => {
  it('standard (issue_before_code enforced) records nothing', async () => {
    await seedWorld(null);
    await profile('standard');
    await mergeRequest(42, UNNAMED, HEAD, null);
    await hostMerged(42, UNNAMED, LANDING);
    expect(await issueCount()).toBe(0);
  });

  it('yolo files one issue at open, linked to the change request, its landing recorded from the merge', async () => {
    await seedWorld(null);
    await profile('yolo');
    await mergeRequest(42, UNNAMED, HEAD, null);
    await hostMerged(42, UNNAMED, LANDING);

    const born = await filed();
    expect(born).toHaveLength(1);
    const [issue] = born;
    expect(issue).toMatchObject({
      title: 'MR 42',
      status: 'open',
      merged_commit_sha: LANDING,
      merged_target: BRANCH,
      created_via: 'system',
    });
    expect(issue?.merged_at).not.toBeNull();
    const links = await rows<{ number: number }>(sql`
      SELECT p.number FROM repo_pull_request_issues l
        JOIN repo_pull_requests p ON p.id = l.pull_request_id
       WHERE l.issue_id = ${issue?.id}`);
    expect(links).toEqual([{ number: 42 }]);

    // the same merge delivered again files nothing more
    await hostMerged(42, UNNAMED, LANDING);
    expect(await filed()).toHaveLength(1);
    expect(await issueCount()).toBe(1);

    // its master is owed the claim and the move to awaiting_release
    const { landedWorkOwed } = await import('../../src/pipeline/index.js');
    const owed = await landedWorkOwed(world.projectId);
    expect(owed).toEqual([
      expect.objectContaining({ issueId: issue?.id, status: 'open', commit: LANDING }),
    ]);
  });

  it('yolo files one for a merge the projection holds no request for, titled from the branch, once per landing commit', async () => {
    await seedWorld(null);
    await profile('yolo');
    await hostMerged(77, UNNAMED, LANDING);
    expect(await filed()).toEqual([
      expect.objectContaining({
        title: `Merge of ${UNNAMED} into ${BRANCH}`,
        status: 'open',
        merged_commit_sha: LANDING,
      }),
    ]);
    // nothing links it to a request, so only its landing commit says it was filed already: the
    // redelivery is answered as done, never left failing on the live detector key's unique index
    await hostMerged(77, UNNAMED, LANDING);
    expect(await issueCount()).toBe(1);
    const failing = await rows<{ state: string; output: unknown }>(sql`
      SELECT state, output FROM pgboss_v12.job
       WHERE name = 'outbox.issue-merge-stamp' AND state IN ('retry', 'failed')`);
    expect(failing).toEqual([]);
  });
});
