/**
 * The issue a master files for a merge naming no issue closes on the release that already shipped
 * that merge, from `draft` (ISS-774). On forge dev, 2026-10-30, the master filed and marked all 13
 * owed merges, and none could close: ISS-784 (marked at #1233's 132998bdf, shipped in
 * 0.4.0-dev.348) was refused by every door. The release record would not claim a draft
 * (CLAIM_CONFLICT), the machine drew no draft → awaiting_release, draft → closed asked a design, and
 * `open` would dispatch a run for work already done. Now the shipped-in record takes such a draft
 * onto the shipped release whose commit the repository says contains the merge, and the
 * `filing_released` edge closes it there; anything else stays refused by name.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-in.ts
 * @direct-test-of packages/core/src/issues/filing-close-guard.ts
 * @direct-test-of packages/core/src/issues/owed-merges.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject } from '../helpers/factories.js';
import {
  BRANCH,
  hostMerged,
  issue,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';
import { contains, messages } from '../helpers/planted-gitlab-merges.js';
import { boxToken } from '../helpers/preview-world.js';

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

const CODE_FIRST = { gates: { profile: 'standard', overrides: { issue_before_code: 'off' } } };
const PR_1233 = '132998bd'.repeat(5);
const TAG_348 = '6283e651'.repeat(5);
const EVIDENCE = 'git merge-base --is-ancestor 132998bd dev-v0.4.0-dev.348 answered yes';

let box = '';

async function codeFirstWorld() {
  await settleOutbox();
  await seedWorld(null, CODE_FIRST);
  box = await boxToken(world.ownerId, await createTestDevice(world.ownerId));
}

/** A merge into the default branch whose request links no issue, its commit naming none. */
async function unlinkedMerge(number: number, sha: string) {
  const branch = `fix/no-key-${number}`;
  await mergeRequest(number, branch, `${String(number).padStart(4, '0')}${'e'.repeat(36)}`, null);
  messages.set(sha, `Merge pull request #${number} from SidCorp-co/${branch}`);
  await hostMerged(number, branch, sha);
}

/** The master's filing: a draft, marked merged at the merge it answers (observed). */
async function filedAndMarked(seq: number, commit: string): Promise<string> {
  const id = await issue(seq, 'draft');
  const res = await api(box, 'POST', `/api/issues/${id}/merge`, { commit, target: BRANCH });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return id;
}

/** A release-batch run that shipped `version`, verified serving `commit`, whose commit holds `holds`. */
async function shipped(version: string, commit: string, holds: string[]): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${world.projectId}, 'system', 'completed', now(), now(), ${version}, now(),
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
  contains.set(commit, new Set(holds));
  return id;
}

const record = (issueId: string, version: string | null, projectId = world.projectId) =>
  api(world.token, 'POST', `/api/projects/${projectId}/shipped-in-records`, {
    issueId,
    version,
    evidence: EVIDENCE,
  });

const runCount = async () =>
  (
    await rows<{ runs: number }>(
      sql`SELECT count(*)::int AS runs FROM pipeline_runs WHERE project_id = ${world.projectId}`,
    )
  )[0]?.runs;

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

describe('a draft filed for an owed merge closes on the release that shipped it', () => {
  it('records ISS-784 on 0.4.0-dev.348 and closes it from draft, with no cut and no run', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);
    const runId = await shipped('0.4.0-dev.348', TAG_348, [PR_1233]);
    const before = await runCount();

    const res = await record(iss784, '0.4.0-dev.348');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ version: '0.4.0-dev.348', runId, closed: true });
    expect(await statusOf(iss784)).toBe('closed');
    const [move] = await rows<{ from_status: string; to_status: string }>(sql`
      SELECT from_status, to_status FROM kernel_transitions
       WHERE entity_id = ${iss784} AND to_status = 'closed'`);
    expect(move).toMatchObject({ from_status: 'draft', to_status: 'closed' });
    const after = await runCount();
    expect(after, 'a run dispatched or a release cut for work already shipped').toBe(before);

    const read = await api(world.token, 'GET', `/api/issues/${iss784}`);
    expect(JSON.stringify(read.body)).toContain('"shippedIn":{');
    expect(JSON.stringify(read.body)).toContain('0.4.0-dev.348');
  });

  it('takes a later shipped release whose commit descends from the merge', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);
    const later = 'a1'.repeat(20);
    await shipped('0.4.0-dev.360', later, [PR_1233, TAG_348]);

    const res = await record(iss784, '0.4.0-dev.360');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await statusOf(iss784)).toBe('closed');
  });

  it('refuses a release whose commit does not contain the merge, and leaves the draft', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);
    await shipped('0.4.0-dev.347', 'b2'.repeat(20), []);

    const res = await record(iss784, '0.4.0-dev.347');
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('RELEASE_SHIPPED_IN_NOT_CONTAINED');
    expect(await statusOf(iss784)).toBe('draft');
  });

  it('refuses `version: null` for a filing: no cut carries a draft', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);

    const res = await record(iss784, null);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('no release cut carries a draft');
    expect(await statusOf(iss784)).toBe('draft');
  });

  it('refuses a draft whose landing is no owed filing', async () => {
    await codeFirstWorld();
    const own = 'c3'.repeat(20);
    messages.set(own, 'fix(core): the header keeps its height (ISS-790)');
    const iss790 = await filedAndMarked(790, own);
    await shipped('0.4.0-dev.348', TAG_348, [own]);

    const res = await record(iss790, '0.4.0-dev.348');
    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain('RELEASE_SHIPPED_IN_NOT_WAITING');
    expect(body).toContain('no merge this project owed a filing for');
    expect(await statusOf(iss790)).toBe('draft');
  });

  it('refuses the record on another project', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);
    await shipped('0.4.0-dev.348', TAG_348, [PR_1233]);
    const other = (await createTestProject(world.ownerId)).id;
    await db.execute(sql`
      INSERT INTO project_members (project_id, user_id, role) VALUES (${other}, ${world.ownerId}, 'admin')
      ON CONFLICT DO NOTHING`);

    const res = await record(iss784, '0.4.0-dev.348', other);
    expect(JSON.stringify(res.body)).toContain('RELEASE_SHIPPED_IN_NOT_WAITING');
    expect(await statusOf(iss784)).toBe('draft');
  });

  it('keeps the kernel edge closed to a draft no release claimed', async () => {
    await codeFirstWorld();
    await unlinkedMerge(1233, PR_1233);
    const iss784 = await filedAndMarked(784, PR_1233);
    const plain = await issue(791, 'draft');

    const filed = await api(world.token, 'POST', `/api/issues/${iss784}/transition`, {
      toStatus: 'closed',
      reason: 'shipped already',
    });
    expect(JSON.stringify(filed.body)).toContain('CLOSE_ONLY_BY_RELEASE');
    expect(JSON.stringify(filed.body)).toContain('shipped-in-records');
    const other = await api(world.token, 'POST', `/api/issues/${plain}/transition`, {
      toStatus: 'closed',
      reason: 'shipped already',
    });
    expect(JSON.stringify(other.body)).toContain('DESIGN_NOT_DELIVERED');
    expect(await statusOf(iss784)).toBe('draft');
    expect(await statusOf(plain)).toBe('draft');
  });
});
