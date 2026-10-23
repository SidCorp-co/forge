/**
 * The observation the workflow health reads (workflow-step-health `in-observation`): a reading of
 * the code by an observer is preferred over a migrated copy of the design's own text (migration
 * 0376), whichever is newer, and the source travels with it so the read can set a migrated one aside.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { observationOf } from '../../src/workflows/health-inputs.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let workflowId: string;

const emptyReading = { steps: [], edges: [], drift: null };

async function observation(sha: string, source: 'observer' | 'migrated', at: string) {
  await db.execute(sql`
    INSERT INTO project_workflow_observations
      (project_id, workflow_id, at_sha, revision, document, source, written_by, written_by_agency,
       created_at)
    VALUES (${projectId}, ${workflowId}, ${sha.repeat(40)}, 1, ${JSON.stringify(emptyReading)}::jsonb,
            ${source}, ${ownerId}, 'agent', ${at}::timestamptz)
  `);
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  workflowId = randomUUID();
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${workflowId}, ${projectId}, 'observed-flow', 'flow', 1, '{}'::jsonb, ${ownerId})
  `);
});

describe('the observation the health reads', () => {
  it("prefers an observer's reading over a newer migrated copy of the design", async () => {
    await observation('a', 'observer', '2026-10-01T00:00:00Z');
    await observation('b', 'migrated', '2026-10-02T00:00:00Z');
    const read = (await observationOf([workflowId])).get(workflowId);
    expect(read?.atSha).toBe('a'.repeat(40));
    expect(read?.source).toBe('observer');
  });

  it('answers the migrated copy, named as such, where no observer has read the code', async () => {
    await observation('b', 'migrated', '2026-10-02T00:00:00Z');
    const read = (await observationOf([workflowId])).get(workflowId);
    expect(read?.source).toBe('migrated');
  });

  it('reads the newest observer reading when there are several', async () => {
    await observation('a', 'observer', '2026-10-01T00:00:00Z');
    await observation('c', 'observer', '2026-10-03T00:00:00Z');
    const read = (await observationOf([workflowId])).get(workflowId);
    expect(read?.atSha).toBe('c'.repeat(40));
  });
});
