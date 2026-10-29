/**
 * A merge out of the branch work lands on promotes what already landed, and is nobody's landing
 * (REQ-45 BC-16). adminhub-api, 2026-10-27: ISS-23 landed on `release/stg` through !5017; the owner
 * then merged !5020 (`release/stg` into `release/production`), whose description named ISS-23, and
 * Forge read ISS-23 as "merged as e2c9c8274bc5, which Forge observed": the promotion's merge commit
 * overwrote its landing, and a mark made afterwards took the promotion again.
 *
 * ISS-774: the host's report of either merge writes nothing; the landing here is Forge's own record.
 *
 * @direct-test-of packages/core/src/issues/merge-identity.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { owedMarks } from '../../src/issues/owed-merges.js';
import { emitEvent } from '../../src/outbox/index.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  BRANCH,
  hostMerged,
  issue,
  issueRow,
  mergeRequest,
  seedWorld,
  stampObserved,
  world,
} from '../helpers/host-merge-world.js';
import { messages } from '../helpers/planted-gitlab-merges.js';

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

const PRODUCTION = 'release/production';
const OWN = '429caee40400ac5daf98825c2329b5eb191d815a';
const PROMOTION = 'e2c9c8274bc58f9641b0b18083dcee89cec9e2a0';
const STG_HEAD = 'e663b7652530cb466798628dfb9b543fad039e47';

/** !5020 as GitLab's hook delivers it and then reports it merged, an hour after ISS-23's own. */
async function promoted(): Promise<void> {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number: 5020,
        title: 'Release stg to production',
        body: 'Promotes release/stg to production:\n\n- ISS-23',
        html_url: 'https://gitlab.com/acme/canawan-api/-/merge_requests/5020',
        state: 'open',
        head: { ref: BRANCH, sha: STG_HEAD },
        base: { ref: PRODUCTION, sha: 'b'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
  messages.set(
    PROMOTION,
    `Merge branch '${BRANCH}' into '${PRODUCTION}'\n\nRelease stg to production\n\nSee merge request acme/canawan-api!5020`,
  );
  await db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${PROMOTION},
           merged_at = now() + interval '1 hour'
     WHERE project_id = ${world.projectId} AND number = 5020`);
  await emitEvent(db, 'source.merged', {
    projectId: world.projectId,
    headRef: BRANCH,
    baseRef: PRODUCTION,
    commitSha: PROMOTION,
    mergedAt: '2026-10-27T08:14:42.683Z',
    head: null,
  });
  await settleOutbox();
}

async function landedThroughItsOwnRequest(): Promise<string> {
  await settleOutbox();
  await seedWorld({ approval: { required: true } });
  const id = await issue(23, 'awaiting_release');
  await mergeRequest(5017, 'fix/remove-dead-shipment-import-iss-23', 'a6'.repeat(20), null);
  await hostMerged(5017, 'fix/remove-dead-shipment-import-iss-23', OWN, '2026-10-27T06:45:31.222Z');
  await stampObserved(id, OWN, '2026-10-27T06:45:31.222Z');
  return id;
}

describe('a promotion of landed work never replaces an issue’s landing (REQ-45 BC-16)', () => {
  it('keeps ISS-23 merged as its own !5017 after !5020 promotes release/stg', async () => {
    const id = await landedThroughItsOwnRequest();

    await promoted();

    // !5020 does deliver ISS-23 by its description, as the real one did; only its merge is no landing
    const [link] = (await db.execute(sql`
      SELECT l.linked_by FROM repo_pull_request_issues l
        JOIN repo_pull_requests p ON p.id = l.pull_request_id
       WHERE p.number = 5020 AND l.issue_id = ${id}`)) as unknown as Array<{ linked_by: string }>;
    expect(link?.linked_by).toBe('description');
    expect(await issueRow(id)).toMatchObject({ merged_commit_sha: OWN, merged_target: BRANCH });
  });

  it('marks ISS-23 at its own merge again, never at the promotion that came later', async () => {
    const id = await landedThroughItsOwnRequest();
    await promoted();

    expect((await api(world.token, 'DELETE', `/api/issues/${id}/merge`, {})).status).toBe(200);
    const mark = await api(world.token, 'POST', `/api/issues/${id}/merge`, { target: BRANCH });

    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    expect(await issueRow(id)).toMatchObject({ merged_commit_sha: OWN, merged_target: BRANCH });
  });

  // ISS-774: the host's report of the issue's own merge writes no mark either; the issue owes it
  it('owes, and is not given, the mark for its own request merged into the landing branch', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const id = await issue(25, 'awaiting_release');
    await mergeRequest(5019, 'fix/per-database-named-locks-iss-25', 'cc'.repeat(20), null);

    await hostMerged(5019, 'fix/per-database-named-locks-iss-25', STG_HEAD);

    expect(await issueRow(id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    expect(await owedMarks(world.projectId)).toEqual([
      expect.objectContaining({ issueId: id, number: 5019, commit: STG_HEAD }),
    ]);
  });
});
