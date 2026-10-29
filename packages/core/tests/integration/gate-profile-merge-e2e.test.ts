/**
 * REQ-76 BC-8 as ISS-774 revises it (owner, 2026-10-29: Forge tells the agent and the agent records):
 * on a yolo project an agent may change code first, and a merge onto the project's base branch that
 * delivers no issue is owed to the master as "file the issue for merge !N at <sha>". Forge files
 * nothing from the host's report; the master's filing, marked merged at that commit, answers it.
 * Under standard (`issue_before_code` enforced) nothing is owed.
 *
 * @direct-test-of packages/core/src/issues/owed-merges.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { mastersPorts } from '../../src/masters/ports.js';
import { api } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  BRANCH,
  hostMerged,
  issue,
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

const issueCount = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${world.projectId}`,
    )
  )[0]?.n;

const owedToMaster = async () => (await mastersPorts().mergesOwed(world.projectId)).filings;

describe('REQ-76 BC-8 under ISS-774: a merge naming no issue is owed a filing, never filed by Forge', () => {
  it('standard (issue_before_code enforced) owes nothing and files nothing', async () => {
    await seedWorld(null);
    await profile('standard');
    await mergeRequest(42, UNNAMED, HEAD, null);
    await hostMerged(42, UNNAMED, LANDING);
    expect(await issueCount()).toBe(0);
    expect(await owedToMaster()).toEqual([]);
  });

  it('yolo files no issue, and owes the master the filing for !42 at its commit, until a mark names it', async () => {
    await seedWorld(null);
    await profile('yolo');
    await mergeRequest(42, UNNAMED, HEAD, null);
    await hostMerged(42, UNNAMED, LANDING);

    expect(await issueCount()).toBe(0);
    const owed = await owedToMaster();
    expect(owed).toEqual([
      expect.objectContaining({ number: 42, commit: LANDING, title: 'MR 42' }),
    ]);

    // the master files it and marks it merged at that commit: the mark answers the filing
    const id = await issue(1, 'in_progress');
    const mark = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: LANDING,
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    expect(await owedToMaster()).toEqual([]);
  });
});
