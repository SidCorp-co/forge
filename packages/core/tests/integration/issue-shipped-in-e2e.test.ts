/**
 * FB-102: an issue and a requirement never named the release that shipped them — dev's REQ-16
 * delivered and named none, and ISS-294's shipping release (dev.72) was only in comment prose. The
 * issue's detail and each issue on its requirement now carry `shippedIn`, and the requirement its
 * `releases`: read off the shipped release runs, the roster each was cut with and the rows it closed
 * afterwards (`metadata.rosterClosed`). An issue a reopen took out of `closed` names none until a
 * release closes it again (ISS-489 r4).
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/pipeline/release-runs.ts
 * @direct-test-of packages/core/src/issues/release-evidence.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestRelease,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

let say: ReturnType<typeof requester>;
let projectId = '';
let owner = '';
const T = (day: number) => new Date(Date.UTC(2026, 9, day));

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  owner = (await createTestUser({ verified: true })).id;
  say = requester(app, { owner: await signUserToken(owner) });
  projectId = (await createTestProject(owner)).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the release that shipped an issue', () => {
  it('names it on the issue and on its requirement, and none while nothing shipped it', async () => {
    const req = await createTestRequirement(projectId, 16, 'Delivered requirement');
    const onRoster = await createTestIssue(projectId, owner, 1, {
      status: 'closed',
      createdAt: T(1),
      mergedAt: T(2),
      requirementId: req.id,
    });
    const closedAfter = await createTestIssue(projectId, owner, 2, {
      status: 'closed',
      createdAt: T(1),
      mergedAt: T(2),
      requirementId: req.id,
    });
    const waiting = await createTestIssue(projectId, owner, 3, {
      status: 'awaiting_release',
      createdAt: T(1),
      mergedAt: T(3),
      requirementId: req.id,
    });
    await createTestRelease(projectId, '0.1.0', [onRoster.id], T(4));
    // an earlier release's commit carried it, and the later release closed it against that ship
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
      VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${T(5).toISOString()}, ${T(5).toISOString()},
              '0.1.1', ${T(5).toISOString()}, ${JSON.stringify({ issueIds: [], rosterClosed: [closedAfter.id] })}::jsonb)
    `);

    const issue = async (id: string): Promise<Doc> =>
      ok(await say('owner', 'GET', `/api/issues/${id}?projectId=${projectId}`));
    expect((await issue(onRoster.id)).shippedIn).toMatchObject({ version: '0.1.0' });
    expect((await issue(closedAfter.id)).shippedIn).toMatchObject({ version: '0.1.1' });
    expect((await issue(waiting.id)).shippedIn).toBeNull();

    const detail = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}`),
    );
    expect(
      (detail.issues as Doc[]).map((i) => [
        i.displayId.replace(/^.*-/, ''),
        i.shippedIn?.version ?? null,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['1', '0.1.0'],
        ['2', '0.1.1'],
        ['3', null],
      ]),
    );
    expect((detail.releases as Doc[]).map((r) => r.version)).toEqual(['0.1.0', '0.1.1']);
  });

  // ISS-489 r4: reopened out of 0.4.0-dev.215 (which shipped round 1), the issue still read shipped
  // there while rounds 2 to 4 were in no release
  it('names no release while a reopen has taken the issue out of closed, and the next close names its release', async () => {
    const req = await createTestRequirement(projectId, 17, 'Reopened requirement');
    const reopened = await createTestIssue(projectId, owner, 4, {
      status: 'in_progress',
      createdAt: T(1),
      mergedAt: T(2),
      requirementId: req.id,
    });
    const moved = (from: string | null, to: string, at: Date) =>
      db.execute(sql`
        INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
        VALUES (${randomUUID()}, 'issue', ${reopened.id}, ${from}, ${to}, 'system', 'agent', 'fixture', ${at.toISOString()})`);
    await createTestRelease(projectId, '0.2.0', [reopened.id], T(4));
    await moved('awaiting_release', 'closed', T(4));
    await moved('closed', 'reopen', T(6));
    await moved('reopen', 'in_progress', T(7));

    const issue = async (): Promise<Doc> =>
      ok(await say('owner', 'GET', `/api/issues/${reopened.id}?projectId=${projectId}`));
    const onRequirement = async () => {
      const detail = ok(
        await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}`),
      );
      return {
        shippedIn: (detail.issues as Doc[])[0]?.shippedIn ?? null,
        releases: (detail.releases as Doc[]).map((r) => r.version),
      };
    };
    expect((await issue()).shippedIn).toBeNull();
    expect(await onRequirement()).toEqual({ shippedIn: null, releases: [] });
    // the release's own record still names what it shipped
    const [run] = await db.execute<{ ids: string[] }>(sql`
      SELECT metadata -> 'issueIds' AS ids FROM pipeline_runs WHERE project_id = ${projectId} AND release_version = '0.2.0'`);
    expect(run?.ids).toEqual([reopened.id]);

    await createTestRelease(projectId, '0.2.1', [reopened.id], T(9));
    await moved('awaiting_release', 'closed', T(9));
    expect((await issue()).shippedIn).toMatchObject({ version: '0.2.1' });
    expect((await onRequirement()).releases).toEqual(['0.2.1']);
  });
});
