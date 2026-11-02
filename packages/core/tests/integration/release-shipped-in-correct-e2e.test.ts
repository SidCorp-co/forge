/**
 * ISS-846 (FB-452): a shipped-in record that named the wrong release is corrected. On agenfold,
 * ISS-35 landed before both 0.37.0 and 0.38.0 were cut and was recorded as shipped in 0.38.0; the
 * record closed it, so a second record naming 0.37.0, the release that truly holds it, was refused
 * RELEASE_SHIPPED_IN_NOT_WAITING and nothing could correct it. The same call with `corrects` and a
 * `reason` moves it: 0.37.0 lists it, 0.38.0 does not, the record that named 0.38.0 stays readable
 * marked superseded, and the issue stays closed. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-in-correct.ts
 * @direct-test-of packages/core/src/release-batch/versions.ts
 * @direct-test-of packages/core/src/pipeline/release-runs.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { A, C1, C2, markTrailWorld } from '../helpers/mark-trail-world.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { claim } = markTrailWorld();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function shipped(version: string, commit: string, cutAgo: number): Promise<string> {
  const id = randomUUID();
  const at = minutesAgo(cutAgo);
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', 'completed', ${at}::timestamptz, ${at}::timestamptz,
            ${version}, ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
  return id;
}

async function markedLate(landedAgo: number): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await db.execute(
    sql`UPDATE issues SET merged_commit_sha = ${A}, merged_at = ${minutesAgo(landedAgo)}::timestamptz WHERE id = ${id}`,
  );
  await claim(id, A);
  return id;
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const record = (body: Record<string, unknown>) =>
  api(token, 'POST', `/api/projects/${projectId}/shipped-in-records`, body);

const releaseIssues = async (version: string) => {
  const read = await api(token, 'GET', `/api/projects/${projectId}/releases/${version}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return JSON.stringify(read.body);
};

const shippedInOf = async (id: string) => {
  const read = await api(token, 'GET', `/api/issues/${id}`);
  return (read.body as { shippedIn?: { version: string } | null }).shippedIn?.version ?? null;
};

const metaOf = async (runId: string) =>
  (
    await rows<{ metadata: Record<string, unknown> }>(
      sql`SELECT metadata FROM pipeline_runs WHERE id = ${runId}`,
    )
  )[0]?.metadata ?? {};

const codeOf = (body: unknown) => JSON.stringify(body);

const EVIDENCE = `git tag --contains ${A} answered v0.37.0 v0.38.0`;
const REASON = 'tag v0.37.0 points at the landing commit itself; 0.38.0 was named by mistake';

/** agenfold's shape: the landing is in 0.37.0 and in 0.38.0, and the record named 0.38.0. */
async function agenfold() {
  const v37 = await shipped('0.37.0', C1, 90);
  const v38 = await shipped('0.38.0', C2, 60);
  const id = await markedLate(120);
  const first = await record({ issueId: id, version: '0.38.0', evidence: EVIDENCE });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(await statusOf(id)).toBe('closed');
  return { v37, v38, id };
}

describe('a shipped-in record that named the wrong release', () => {
  it('is corrected to the release that holds the landing, and the releases follow', async () => {
    const { v37, v38, id } = await agenfold();
    expect(await shippedInOf(id)).toBe('0.38.0');
    expect(await releaseIssues('0.38.0')).toContain(id);

    const fixed = await record({
      issueId: id,
      version: '0.37.0',
      corrects: '0.38.0',
      reason: REASON,
      evidence: EVIDENCE,
    });

    expect(fixed.status, codeOf(fixed.body)).toBe(201);
    expect(fixed.body).toMatchObject({
      version: '0.37.0',
      runId: v37,
      closed: true,
      corrected: { version: '0.38.0', runId: v38 },
    });
    expect(await statusOf(id)).toBe('closed');
    expect(await shippedInOf(id)).toBe('0.37.0');
    expect(await releaseIssues('0.37.0')).toContain(id);
    expect(await releaseIssues('0.38.0')).not.toContain(id);

    // the record that named 0.38.0 is kept, marked superseded with who, when and why
    const old = await metaOf(v38);
    expect(old.rosterClosed).toEqual([id]);
    expect(old.rosterSuperseded).toEqual([id]);
    expect(old.shippedInCorrections).toEqual([
      expect.objectContaining({
        issueId: id,
        role: 'superseded',
        from: '0.38.0',
        to: '0.37.0',
        reason: REASON,
        by: ownerId,
      }),
    ]);
    expect((await metaOf(v37)).rosterClosed).toEqual([id]);

    const [activity] = await rows<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM activity_log WHERE issue_id = ${id} AND action = 'issue.shippedInCorrected'`,
    );
    expect(activity?.payload).toMatchObject({ from: '0.38.0', to: '0.37.0', reason: REASON });
    const [notice] = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${id} AND body LIKE '%corrected from 0.38.0%'`,
    );
    expect(notice?.body).toContain(REASON);
  });

  it('reads on both releases: moved off 0.38.0 to 0.37.0, and onto 0.37.0 from 0.38.0', async () => {
    const { id } = await agenfold();
    const fixed = await record({
      issueId: id,
      version: '0.37.0',
      corrects: '0.38.0',
      reason: REASON,
      evidence: EVIDENCE,
    });
    expect(fixed.status, codeOf(fixed.body)).toBe(201);
    const issue = (await api(token, 'GET', `/api/issues/${id}`)).body as {
      displayId: string;
      title: string;
    };
    const correctionsOf = async (version: string) => {
      const read = await api(token, 'GET', `/api/projects/${projectId}/releases/${version}`);
      expect(read.status, codeOf(read.body)).toBe(200);
      return (read.body as { release: { corrections: unknown[] } }).release.corrections;
    };
    const entry = {
      key: issue.displayId,
      title: issue.title,
      from: '0.38.0',
      to: '0.37.0',
      by: expect.objectContaining({ id: ownerId, name: expect.any(String) }),
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      reason: REASON,
      evidence: EVIDENCE,
    };
    expect(await correctionsOf('0.38.0')).toEqual([{ direction: 'out', ...entry }]);
    expect(await correctionsOf('0.37.0')).toEqual([{ direction: 'in', ...entry }]);
  });

  it('can be corrected back, the newest correction deciding which release lists it', async () => {
    const { v38, id } = await agenfold();
    await record({
      issueId: id,
      version: '0.37.0',
      corrects: '0.38.0',
      reason: REASON,
      evidence: EVIDENCE,
    });
    const back = await record({
      issueId: id,
      version: '0.38.0',
      corrects: '0.37.0',
      reason: 'the first record was right after all',
      evidence: EVIDENCE,
    });
    expect(back.status, codeOf(back.body)).toBe(201);
    expect(await shippedInOf(id)).toBe('0.38.0');
    expect(await releaseIssues('0.37.0')).not.toContain(id);
    expect((await metaOf(v38)).shippedInCorrections).toHaveLength(2);
  });
});

describe('a correction refused by name', () => {
  const correct = (id: string, extra: Record<string, unknown>) =>
    record({
      issueId: id,
      version: '0.37.0',
      corrects: '0.38.0',
      reason: REASON,
      evidence: EVIDENCE,
      ...extra,
    });

  it('whose `corrects` is not the version the issue ships in now', async () => {
    const { id } = await agenfold();
    const sent = await correct(id, { corrects: '0.36.0' });
    expect(sent.status).toBe(422);
    expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_CORRECTS_MISMATCH');
    expect(codeOf(sent.body)).toContain('corrects: \\"0.38.0\\"');
    expect(await shippedInOf(id)).toBe('0.38.0');
  });

  it('without a reason, or with an empty one', async () => {
    const { id } = await agenfold();
    for (const reason of [undefined, '   ']) {
      const sent = await correct(id, { reason });
      expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_REASON_MISSING');
    }
    expect(await shippedInOf(id)).toBe('0.38.0');
  });

  it('naming a version that fails the checks a first record is held to', async () => {
    const { id } = await agenfold();
    const unknown = await correct(id, { version: '9.9.9' });
    expect(codeOf(unknown.body)).toContain('RELEASE_SHIPPED_IN_UNKNOWN');
    await shipped('0.36.0', C1, 180);
    const early = await correct(id, { version: '0.36.0' });
    expect(codeOf(early.body)).toContain('RELEASE_SHIPPED_IN_BEFORE_LANDING');
    const none = await correct(id, { version: null });
    expect(codeOf(none.body)).toContain('RELEASE_SHIPPED_IN_CORRECTION_NONE');
    expect(await shippedInOf(id)).toBe('0.38.0');
  });

  it('on an issue no shipped-in record closed, which takes the record without it', async () => {
    await shipped('0.37.0', C1, 90);
    await shipped('0.38.0', C2, 60);
    const waiting = await markedLate(120);
    const sent = await correct(waiting, {});
    expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_NOT_CORRECTABLE');
    expect(codeOf(sent.body)).toContain('without `corrects`');
    expect(await statusOf(waiting)).toBe('awaiting_release');
  });

  it("on an issue its release's own roster closed", async () => {
    const { v38, id } = await agenfold();
    // the shape a release's own finish leaves: the issue on the roster it was cut with
    await db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata || ${JSON.stringify({ issueIds: [id] })}::jsonb
       WHERE id = ${v38}`);
    const sent = await correct(id, {});
    expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_NOT_CORRECTABLE');
    expect(codeOf(sent.body)).toContain('own roster');
  });

  it('naming the version it already ships in', async () => {
    const { id } = await agenfold();
    const sent = await correct(id, { version: '0.38.0' });
    expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_CORRECTION_SAME');
  });

  it('a `reason` sent on a first record, which corrects nothing', async () => {
    await shipped('0.37.0', C1, 90);
    const id = await markedLate(120);
    const sent = await record({
      issueId: id,
      version: '0.37.0',
      reason: REASON,
      evidence: EVIDENCE,
    });
    expect(codeOf(sent.body)).toContain('RELEASE_SHIPPED_IN_REASON_UNUSED');
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('a second first record on the closed issue names the correction instead', async () => {
    const { id } = await agenfold();
    const again = await record({ issueId: id, version: '0.37.0', evidence: EVIDENCE });
    expect(codeOf(again.body)).toContain('RELEASE_SHIPPED_IN_NOT_WAITING');
    expect(codeOf(again.body)).toContain('corrects');
  });
});
