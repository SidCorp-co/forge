/**
 * A release that ships by merging change requests (REQ-63) runs no job and holds no session: it waits
 * on the owner's accept, then on the master's merges. Planted from catalog-api and adminhub-api on
 * dev, 2026-10-23: each batch cut through the door was cancelled by the pipeline sweep about four
 * minutes later, its roster handed back to the gate, with nothing saying why. The sweep read a
 * system run with no job and no live session as orphaned. Here the sweep runs an hour on, at every
 * stage of the wait, against real Postgres; only the owner's abort or the last merge ends the run.
 *
 * The same catalog-api cut carried a name drafted a week earlier for a roster release records had
 * since shipped. A draft's name describes what waited at the gate when it was written, so a cut none
 * of whose issues waited then does not carry it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { openOneShotRun } from '../../src/pipeline/index.js';
import { runPipelineSweep } from '../../src/pipeline-sweep.js';
import { nextDraftVersion } from '../../src/release-batch/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  sourceHostForBinding: async () => ({
    provider: 'gitlab',
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    merge: async ({ number }: { number: number }) => ({
      kind: 'merged',
      commitSha: `${String(number).padStart(4, '0')}${'c'.repeat(36)}`,
      mergedAt: new Date(),
      target: 'release/stg',
      head: null,
    }),
    sameTree: async () => true,
  }),
}));

const BRANCH = 'release/stg';
const NOTE = { section: 'Added', userFacing: 'A site writes through to the catalog.' };
const HOUR_MS = 60 * 60_000;

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

async function seedWorld(): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: { repository: 'gitlab.com/acme/catalog-api', defaultBranch: BRANCH, branches: [BRANCH] },
    },
    extra: {
      delivery: { verdictsRequired: false },
      release: { approval: { required: true }, changeRequests: true },
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
            ${JSON.stringify({ repository: 'acme/catalog-api' })}::jsonb)
  `);
}

/** An issue at the release gate, its arrival there recorded at `arrived`. */
async function gated(seq: number, arrived: Date): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await seedIssueStatus(id, 'awaiting_release');
  await db.execute(sql`
    INSERT INTO kernel_transitions
      (entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    VALUES ('issue', ${id}, 'in_progress', 'awaiting_release', 'system', 'agent', 'test',
            ${arrived.toISOString()})
  `);
  return id;
}

async function mergeRequest(number: number, headRef: string, head: string): Promise<void> {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: `MR ${number}`,
        body: null,
        html_url: `https://gitlab.com/acme/catalog-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: headRef, sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/catalog-api' },
    },
  );
}

/** ISS-1 through !10 and ISS-2 through !11, both at the gate since `arrived`. */
async function stack(arrived = new Date()) {
  const one = await gated(1, arrived);
  const two = await gated(2, arrived);
  await mergeRequest(10, 'feat/site-write-iss-1', 'a1'.repeat(20));
  await mergeRequest(11, 'fix/token-iss-2', 'b2'.repeat(20));
  return { one, two };
}

async function cut(issueIds: string[]): Promise<{ runId: string; version: string }> {
  const res = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
    issueIds,
    changeRequests: [10, 11],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body).toMatchObject({ jobId: null, verification: 'merged' });
  return { runId: String(res.body.runId), version: String(res.body.version) };
}

async function standing(runId: string) {
  const [run] = await rows<{ status: string; metadata: Record<string, unknown> }>(sql`
    SELECT status, metadata FROM pipeline_runs WHERE id = ${runId}`);
  const claimed = await rows<{ id: string }>(sql`
    SELECT id FROM issues WHERE release_batch_run_id = ${runId} ORDER BY iss_seq`);
  return { status: run?.status, metadata: run?.metadata, claimed: claimed.length };
}

/** The pipeline sweep, as the minute timer runs it, `hours` after now. */
async function sweepLater(hours: number): Promise<void> {
  await runPipelineSweep(new Date(Date.now() + hours * HOUR_MS));
}

async function approve(runId: string): Promise<void> {
  const [pending] = await rows<{ id: string }>(sql`
    SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`);
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'the owner read both merge requests and accepts them' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

describe('a change-request release waits for its accept and its merges, past every sweep', () => {
  beforeEach(seedWorld);

  it('stays open, its roster claimed, while it waits on the owner and then on the master', async () => {
    const { one, two } = await stack();
    const { runId } = await cut([one, two]);

    await sweepLater(1);
    expect(await standing(runId)).toMatchObject({ status: 'running', claimed: 2 });

    await approve(runId);
    await sweepLater(2);
    expect(await standing(runId)).toMatchObject({ status: 'running', claimed: 2 });

    expect((await mergeOf(one, 10)).status).toBe(200);
    await sweepLater(3);
    expect(await standing(runId)).toMatchObject({ status: 'running', claimed: 2 });

    const last = await mergeOf(two, 11);
    expect(last.body).toMatchObject({ release: { runId, settled: true } });
    expect((await standing(runId)).status).toBe('completed');
  });

  it('still closes a system run with no job, no session and no change requests', async () => {
    const { one, two } = await stack();
    const { runId } = await cut([one, two]);
    const orphan = await openOneShotRun({
      projectId: world.projectId,
      kind: 'system',
      metadata: { source: 'release-batch' },
    });
    await sweepLater(1);
    expect((await standing(orphan.id)).status).toBe('cancelled');
    expect((await standing(runId)).status).toBe('running');
  });

  it('ends only by its abort, which names why', async () => {
    const { one, two } = await stack();
    const { runId } = await cut([one, two]);
    const res = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/release-batches/${runId}/abort`,
      { reason: 'the owner withdrew !11 for another review' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await standing(runId);
    expect(after).toMatchObject({ status: 'cancelled', claimed: 0 });
    expect(JSON.stringify(after.metadata)).toContain('the owner withdrew !11 for another review');
  });
});

describe('a cut carries the name drafted for the roster it releases, not an older one', () => {
  beforeEach(seedWorld);

  async function draftNamed(at: Date, name: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO release_draft_namings (project_id, version, name, summary, named_by, named_at)
      VALUES (${world.projectId}, ${await nextDraftVersion(world.projectId)}, ${name},
              ${`${name}: what the draft carried.`}, ${world.ownerId}, ${at.toISOString()})
    `);
  }

  async function namingOf(runId: string): Promise<string | null> {
    const [run] = await rows<{ name: string | null }>(sql`
      SELECT metadata->'naming'->>'name' AS name FROM pipeline_runs WHERE id = ${runId}`);
    return run?.name ?? null;
  }

  it('drops a draft name written before any issue it cuts reached the gate', async () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * HOUR_MS);
    const { one, two } = await stack(new Date(Date.now() - HOUR_MS));
    await draftNamed(weekAgo, 'ePOD deploy');
    const { runId } = await cut([one, two]);
    expect(await namingOf(runId)).not.toBe('ePOD deploy');
    expect(
      await rows(sql`SELECT id FROM release_draft_namings WHERE project_id = ${world.projectId}`),
    ).toEqual([]);
  });

  async function abort(runId: string): Promise<void> {
    const res = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/release-batches/${runId}/abort`,
      { reason: 'cut again' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function nameRun(runId: string, at: Date, name: string): Promise<void> {
    const summary = 'Sites write through to the catalog. Each service holds its own token.';
    const naming = { name, summary, at: at.toISOString(), by: null };
    await db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({ naming })}::jsonb
       WHERE id = ${runId}`);
  }

  it('does not re-cut under the name an earlier attempt carried for another roster', async () => {
    const { one, two } = await stack(new Date(Date.now() - HOUR_MS));
    const first = await cut([one, two]);
    await nameRun(first.runId, new Date(Date.now() - 7 * 24 * HOUR_MS), 'ePOD deploy');
    await abort(first.runId);
    const again = await cut([one, two]);
    expect(again.version).toBe(first.version);
    expect(await namingOf(again.runId)).not.toBe('ePOD deploy');
  });

  it('re-cuts under the name its earlier attempt carried for this roster', async () => {
    const { one, two } = await stack(new Date(Date.now() - 2 * HOUR_MS));
    const first = await cut([one, two]);
    await nameRun(first.runId, new Date(Date.now() - HOUR_MS), 'Safe site sync');
    await abort(first.runId);
    const again = await cut([one, two]);
    expect(await namingOf(again.runId)).toBe('Safe site sync');
  });

  it('carries a draft name written while an issue it cuts waited at the gate', async () => {
    const { one, two } = await stack(new Date(Date.now() - 2 * HOUR_MS));
    await draftNamed(new Date(Date.now() - HOUR_MS), 'Safe site sync');
    const { runId } = await cut([one, two]);
    expect(await namingOf(runId)).toBe('Safe site sync');
  });
});
