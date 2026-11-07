/**
 * The Releases list, and the Needs you and status reads that list each project's releases, read every
 * release a project ever cut. On forge (472 releases, 870 issues, 2507 criteria) GET releases took
 * 16-17 s, 15.9 s of it in the database over 79 statements: a read that grew with the square of the
 * release count, not with it.
 *
 * - Each box verdict with no run named was weighed against its issue's builder sessions, and the
 *   statement read those again for every verdict: every run session against the project's runs
 *   (`issues/built-by.ts:builderCandidatesSql`). Now one pass reads every carried issue's candidates
 *   (`builderCandidatesAcrossSql`).
 * - The release facts scanned every verdict of every carried issue for each criterion, five times a
 *   criterion (`release-facts.ts:loadReleaseFacts`); the verdicts now come keyed by criterion.
 * - The lineage asked every run for each run's predecessor (`version-rule.ts:lineageOf`).
 *
 * Planted as forge stands: hundreds of shipped releases, each issue built and judged by runs on one
 * box, its judges' verdicts recorded half with no run named. The list's statements do not grow with
 * its releases, and six times the releases cost it at most six times the time.
 *
 * @direct-test-of packages/core/src/issues/built-by.ts
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/version-rule.ts
 * @direct-test-of packages/core/src/release-page/facts.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/core/src/issues/criteria/live-verdicts.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { newQueryTiming, withQueryTiming } from '../../src/db/query-timing.js';
import { listReleases } from '../../src/release-batch/release-list-read.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const SMALL = 40;
const LARGE = 240;
/** Six times the releases cost at most six times the time: no worse than linear in them. */
const GROWTH_BOUND = LARGE / SMALL;
const ISSUES_PER_RELEASE = 2;
const CRITERIA = 4;
const VERDICTS = 3;

let projectId = '';
let ownerId = '';
let deviceId = '';

/** Releases `from`..`to` of LARGE, oldest first an hour apart, each shipping its issues. */
async function seedReleases(from: number, to: number): Promise<void> {
  const first = (from - 1) * ISSUES_PER_RELEASE + 1;
  const last = to * ISSUES_PER_RELEASE;
  // issue s ships with release ceil(s / ISSUES_PER_RELEASE), which shipped (LARGE - n) hours ago
  const releaseOf = sql`((s - 1) / ${ISSUES_PER_RELEASE}::int + 1)`;
  const ago = (extra: number) =>
    sql`make_interval(mins => (${LARGE}::int - ${releaseOf}) * 60 + ${extra}::int)`;
  await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, release_notes,
                        merged_at, merged_commit_sha, merged_target)
    SELECT ${projectId}, s, 'issue ' || s, 'closed', ${ownerId},
           '{"section":"Fixed","userFacing":"x"}'::jsonb, now() - ${ago(20)},
           rpad('c' || ${releaseOf}, 40, '0'), 'dev'
      FROM generate_series(${first}::int, ${last}::int) s`);
  await db.execute(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    SELECT i.id, g, 'criterion ' || g, g
      FROM issues i, generate_series(1, ${CRITERIA}::int) g
     WHERE i.project_id = ${projectId} AND i.iss_seq BETWEEN ${first}::int AND ${last}::int`);
  // four runs over each issue on the one box, a round apart: build, judge, fix, judge again
  await db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata, started_at, created_at, finished_at)
    SELECT ${projectId}, 'system', 'completed',
           jsonb_build_object('runGroup', jsonb_build_array('ISS-' || s),
                              'runIssueStatuses', jsonb_build_object('ISS-' || s,
                                (ARRAY['open', 'awaiting_release', 'reopen', 'awaiting_release'])[k]),
                              'seedRound', k),
           now() - ${ago(50)} + make_interval(mins => k * 10),
           now() - ${ago(50)} + make_interval(mins => k * 10),
           now() - ${ago(45)} + make_interval(mins => k * 10)
      FROM generate_series(${first}::int, ${last}::int) s, generate_series(0, 3) k`);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, created_at, updated_at)
    SELECT ${projectId}, ${deviceId}, r.id, 'run_session', 'completed', r.started_at, r.finished_at
      FROM pipeline_runs r
     WHERE r.project_id = ${projectId} AND r.metadata ? 'seedRound'
       AND NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.pipeline_run_id = r.id)`);
  // the last judge's verdicts, half recorded with no run named, as judges that skip --run send them
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_device_id, run_session_id, author_agency,
                                    judge, created_at)
    SELECT c.id, c.issue_id, 'pass', 'judged', 'commit', i.merged_commit_sha, ${ownerId}, ${deviceId},
           CASE WHEN g % 2 = 0 THEN j.id ELSE NULL END, 'agent', 'qa',
           j.created_at + make_interval(secs => 60 + g)
      FROM issues i
      JOIN issue_criteria c ON c.issue_id = i.id
      JOIN LATERAL (
        SELECT a.id, a.created_at FROM agent_sessions a JOIN pipeline_runs r ON r.id = a.pipeline_run_id
         WHERE r.project_id = ${projectId} AND r.metadata -> 'runGroup' ? ('ISS-' || i.iss_seq)
           AND (r.metadata ->> 'seedRound')::int = 3
      ) j ON true,
      generate_series(1, ${VERDICTS}::int) g
     WHERE i.project_id = ${projectId} AND i.iss_seq BETWEEN ${first}::int AND ${last}::int`);
  await db.execute(sql`
    INSERT INTO pipeline_runs (project_id, kind, status, started_at, finished_at, metadata,
                               release_version, release_released_at)
    SELECT ${projectId}, 'system', 'completed', now() - make_interval(mins => (${LARGE}::int - n) * 60),
           now() - make_interval(mins => (${LARGE}::int - n) * 60 - 5),
           jsonb_build_object('source', 'release-batch', 'verification', 'probe',
                              'issueIds', (SELECT jsonb_agg(i.id ORDER BY i.iss_seq) FROM issues i
                                            WHERE i.project_id = ${projectId}
                                              AND i.iss_seq BETWEEN (n - 1) * ${ISSUES_PER_RELEASE}::int + 1
                                                                AND n * ${ISSUES_PER_RELEASE}::int),
                              'finish', jsonb_build_object('state', 'finished',
                                                           'commit', rpad('c' || n, 40, '0'))),
           '0.4.0-dev.' || n, now() - make_interval(mins => (${LARGE}::int - n) * 60 - 5)
      FROM generate_series(${from}::int, ${to}::int) n`);
  await db.execute(sql`ANALYZE`);
}

/** The list's fastest of three reads, and the statements one sends. */
async function timedList(): Promise<{ ms: number; statements: number; releases: number }> {
  let best = Number.POSITIVE_INFINITY;
  let statements = 0;
  let releases = 0;
  for (let k = 0; k < 3; k++) {
    const t = newQueryTiming();
    const start = performance.now();
    const read = await withQueryTiming(t, () => listReleases(projectId, null));
    best = Math.min(best, performance.now() - start);
    statements = t.queries;
    releases = read.releases.length;
  }
  return { ms: best, statements, releases };
}

describe('the releases list grows with its releases, not with their square', () => {
  beforeAll(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    projectId = (await createTestProject(ownerId)).id;
    await addProjectMember(projectId, ownerId, 'admin');
    deviceId = await createTestDevice(ownerId);
    // forge's own production: deployed on landing, its served commit read by a source probe
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'dev',
      environments: {
        dev: {
          tier: 'production',
          deploysFrom: 'dev',
          deployment: { binding: randomUUID(), trigger: 'on-land' },
          verification: {
            runtime: [
              {
                type: 'http',
                url: 'https://forge-fixture.example.test/version',
                path: 'sourceCommit',
                identifies: 'source',
              },
            ],
          },
        },
      } as never,
      extra: {
        delivery: { verdictsRequired: false },
        release: { approval: { required: false }, prerelease: { of: '0.4.0', label: 'dev' } },
      } as never,
    });
  }, 60_000);

  it(`reads ${LARGE} releases in the statements ${SMALL} take, and under ${GROWTH_BOUND} times their time`, async () => {
    await seedReleases(1, SMALL);
    const small = await timedList();
    await seedReleases(SMALL + 1, LARGE);
    const large = await timedList();
    expect([small.releases, large.releases]).toEqual([SMALL, LARGE]);
    expect(large.statements, 'the statements a list sends do not grow with its releases').toBe(
      small.statements,
    );
    const growth = large.ms / small.ms;
    expect(
      growth,
      `${SMALL} releases read in ${small.ms.toFixed(0)} ms, ${LARGE} in ${large.ms.toFixed(0)} ms`,
    ).toBeLessThan(GROWTH_BOUND);
  }, 600_000);
});
