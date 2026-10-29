/**
 * ISS-774 (owner, 2026-10-29: a read path never calls the source host or the box ancestry reader).
 * The release list and readiness, the attention and needs-you reads, and a requirement's standing
 * read a project with a shipped release, issues at the gate and closed, and a requirement tracing an
 * issue with a commit verdict. Every one of them is answered from Forge's own rows: a planted host and
 * a planted box reader count each call they are asked, and are asked none. The same holds on a project
 * with no production environment, whose coverage weighs a pass at a later commit on its landing and
 * whose steward reads a build ahead of it (2026-10-30: `laterHoldersOf` and `aheadBuildsOf` asked
 * GitLab's compare 242 times a minute from dev core, three in four answered 429).
 * Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/judged-build.ts
 * @direct-test-of packages/core/src/release-batch/recorded-holding.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { A, markTrailWorld } from '../helpers/mark-trail-world.js';
import {
  releaseWorld,
  seedProductionDeployTrigger,
  seedProjectDocument,
} from '../helpers/release-world.js';

const asked = vi.hoisted(() => ({ host: [] as string[], box: [] as string[] }));
const SHIPPED = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const JUDGED = 'd'.repeat(40);

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const counted = (name: string, answer: unknown) => async () => {
    asked.host.push(name);
    return answer;
  };
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => ({
      host: 'gitlab.com',
      provider: 'gitlab',
      fullName: 'acme/app',
      compare: counted('compare', 'ahead'),
      branchHead: counted('branchHead', 'b'.repeat(40)),
      readRange: counted('readRange', { ok: true, complete: true, commits: [] }),
    }),
  };
});

vi.mock('../../src/runners/checkout-ancestry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runners/checkout-ancestry.js')>()),
  readCheckoutAncestry: async () => {
    asked.box.push('readCheckoutAncestry');
    return { silent: 'planted box: no read path may ask it' };
  },
}));

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
  asked.host.length = 0;
  asked.box.length = 0;
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  fx.serve('c'.repeat(40));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: ReturnType<typeof api>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function seedWorld(): Promise<{ req: string; issueIds: string[] }> {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${at}::timestamptz, ${at}::timestamptz,
            '0.4.0-dev.1', ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit: SHIPPED, version: 1 } })}::jsonb)
  `);
  // landed before the release was cut and marked after it: the case the removed shipped-earlier read asked the host about
  const gate = await createTestIssue(projectId, ownerId, 1, {
    status: 'open',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    mergedAt: new Date(Date.now() - 7_200_000),
  });
  await db.execute(sql`UPDATE issues SET merged_commit_sha = ${A} WHERE id = ${gate.id}`);
  await claim(gate.id, A);
  await seedIssueStatus(gate.id, 'awaiting_release');
  const closed = await createTestIssue(projectId, ownerId, 2, {
    status: 'open',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    mergedAt: new Date(Date.now() - 7_200_000),
  });
  await db.execute(sql`UPDATE issues SET merged_commit_sha = ${MERGED} WHERE id = ${closed.id}`);
  await seedIssueStatus(closed.id, 'closed');

  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Catalog',
      reason: 'planted',
      criteria: [{ body: 'A site lists its catalog' }],
    }),
  );
  const req = String(created.key);
  await makeAgreeReady(projectId, Number(req.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${req}/revisions/1/propose`, {}));
  await ok(
    onProject('POST', `/requirements/${req}/revisions/1/accept`, {
      reason: 'Accepted for this test.',
    }),
  );
  await ok(
    onProject('POST', `/requirements/${req}/agree`, {
      revision: 1,
      reason: 'Agreed for this test.',
    }),
  );
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: 'ISS-2' }));
  await ok(
    onProject('POST', `/requirements/${req}/verdicts`, {
      criterion: 'BC-1',
      verdict: 'pass',
      reason: 'pass at the shipped commit',
      identity: { kind: 'commit', sha: JUDGED },
      evidence: ['https://forge-dev.example/clips/catalog.webm'],
    }),
  );
  return { req, issueIds: [gate.id, closed.id] };
}

describe('the reads a person opens', () => {
  it('ask the source host and the box nothing, however often they are read', async () => {
    const { req, issueIds } = await seedWorld();
    asked.host.length = 0;
    asked.box.length = 0;
    const reads: Array<[string, string]> = [
      ['releases', onPath('/releases')],
      ['release-readiness', onPath('/release-readiness')],
      ['attention', '/api/me/attention'],
      ['needs-you', onPath('/needs-you')],
      ['needs-you/decisions', onPath('/needs-you/decisions')],
      ['requirements', onPath('/requirements')],
      ['requirement standing', onPath(`/requirements/${req}`)],
      ...issueIds.flatMap(
        (id): Array<[string, string]> => [
          ['issue judged-build', `/api/issues/${id}/judged-build`],
          ['issue criteria', `/api/issues/${id}/criteria`],
        ],
      ),
    ];
    const reached: string[] = [];
    for (const [name, path] of reads) {
      const before = asked.host.length + asked.box.length;
      for (let i = 0; i < 3; i++) {
        const res = await api(token, 'GET', path);
        expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      }
      if (asked.host.length + asked.box.length > before) reached.push(name);
    }
    expect(reached, `GETs that reached the host (${asked.host}) or the box (${asked.box})`).toEqual(
      [],
    );
    expect(asked.host).toEqual([]);
    expect(asked.box).toEqual([]);
  });
});

function onPath(path: string): string {
  return `/api/projects/${projectId}${path}`;
}

describe('the reads on a project with no production environment', () => {
  it('weigh a pass at a later commit on its landing from the records, asking the host nothing', async () => {
    const landedProject = (await createTestProject(ownerId)).id;
    await addProjectMember(landedProject, ownerId, 'admin');
    await seedProjectDocument(landedProject, ownerId, {
      defaultBranch: 'dev',
      environments: { dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' } } },
    });
    const on = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      api(token, method, `/api/projects/${landedProject}${path}`, body);
    // ISS-1 landed on dev at MERGED, its criterion passed at JUDGED, a later build no record names
    const issue = await createTestIssue(landedProject, ownerId, 1, {
      status: 'awaiting_release',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      mergedAt: new Date(Date.now() - 7_200_000),
    });
    await db.execute(
      sql`UPDATE issues SET merged_commit_sha = ${MERGED}, merged_target = 'dev' WHERE id = ${issue.id}`,
    );
    const created = await ok(
      on('POST', '/requirements', {
        title: 'Errors',
        reason: 'planted',
        criteria: [{ body: 'A failing call shows its error once' }],
      }),
    );
    const req = String(created.key);
    await makeAgreeReady(landedProject, Number(req.slice(4)), ownerId);
    await ok(on('POST', `/requirements/${req}/revisions/1/propose`, {}));
    await ok(
      on('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'Accepted for this test.' }),
    );
    await ok(
      on('POST', `/requirements/${req}/agree`, { revision: 1, reason: 'Agreed for this test.' }),
    );
    await ok(on('POST', `/requirements/${req}/issues`, { issue: 'ISS-1' }));
    const [bc] = await rows<{ id: string }>(sql`
      SELECT rc.id FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
       WHERE r.project_id = ${landedProject} AND rc.code = 'BC-1' LIMIT 1`);
    const [c] = await rows<{ id: string }>(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
      VALUES (${issue.id}, 1, 'the error shows once', 0, ${bc?.id}) RETURNING id`);
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                      author_agency, author_user_id, evidence, created_at)
      VALUES (${c?.id}, ${issue.id}, 'pass', 'commit', ${JUDGED}, 'agent', ${ownerId},
              ARRAY['iss1.txt'], now())`);
    asked.host.length = 0;
    asked.box.length = 0;
    const reached: string[] = [];
    for (const [name, path] of [
      ['requirement standing', `/api/projects/${landedProject}/requirements/${req}`],
      ['requirements', `/api/projects/${landedProject}/requirements`],
      ['needs-you', `/api/projects/${landedProject}/needs-you`],
      ['attention', '/api/me/attention'],
      ['issue criteria', `/api/issues/${issue.id}/criteria`],
    ] as const) {
      const before = asked.host.length + asked.box.length;
      const res = await api(token, 'GET', path);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      if (asked.host.length + asked.box.length > before) reached.push(name);
    }
    expect(reached, `GETs that reached the host (${asked.host}) or the box (${asked.box})`).toEqual(
      [],
    );
  });
});
