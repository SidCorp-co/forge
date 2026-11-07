// A criterion's coverage reads the newest verdict of each class its readers tell apart, not every
// verdict ever recorded on it (`requirements/standing-facts.ts:VERDICT_CLASS_SQL`, ISS-1070 r6). Over
// a history of many verdicts per criterion, of every kind, author, identity and side of a reopen and
// of the builder cutover, the classes answer what every verdict answers: the verdict each judge
// stands on (`@forge/contracts/verified-rule:judgesVerdict`, `standing-coverage.ts:judgesOf`), the
// identities whose live build is asked (`standing-live-build.ts:commitBuildOf`), what a reopen voids,
// and each requirement's whole standing, where `withoutUnplaced` sets aside a runtime nothing places.
// Against real Postgres.
// @direct-test-of packages/core/src/requirements/standing-facts.ts

import { judgesVerdict, type VerifiedJudge } from '@forge/contracts/verified-rule';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { needsYouViewerOf } from '../../src/development/needs-you-viewer.js';
import { drainStaleBuilderFacts } from '../../src/issues/builder-facts.js';
import { loadProjectAccess } from '../../src/lib/authz.js';
import { liveBuildOfRequirement } from '../../src/requirements/acceptance.js';
import { listRequirementsAs } from '../../src/requirements/index.js';
import type { StandingIssueCriterion } from '../../src/requirements/standing.js';
import { everyVerdictRead, issueCriteriaOf } from '../../src/requirements/standing-facts.js';
import { createTestUser } from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { seedAtScale } from '../helpers/scale-world.js';

const SHAS = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
const LIVE = '9'.repeat(40);
/** What a runtime verdict names: two refs nothing serves, and the live commit. */
const RUNTIMES = ['4'.repeat(40), '5'.repeat(40), LIVE];

let projectId: string;
let ownerId: string;
let unplant: (() => void) | null = null;

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = await seedAtScale(ownerId, {
    requirements: 3,
    criteriaPerRequirement: 3,
    issues: 40,
    criteriaPerIssue: 3,
    verdictsPerCriterion: 1,
    releases: 4,
    feedback: 4,
    activityPerIssue: 1,
    open: 10,
  });
  // the live build holds the first commit, a later release the second; nothing answers the third
  unplant = plantLiveBuild(LIVE, { [SHAS[0] as string]: true, [SHAS[1] as string]: false });
  await db.transaction(async (tx) => {
    // the same history every run: Postgres's random() from a fixed seed, in this one session
    await tx.execute(sql`SELECT setseed(0.31)`);
    // the world's one verdict per criterion gives way to the history below
    await tx.execute(sql`
      DELETE FROM criterion_verdicts cv USING issues i
       WHERE i.id = cv.issue_id AND i.project_id = ${projectId}`);
    // a judge mostly passing or failing one commit again and again, as histories run, with now and
    // then another commit, a runtime, a release, no author, a scope, or a verdict before the cutover
    await tx.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind,
                                      commit_sha, runtime_ref, release_version, author_user_id,
                                      reason, covers, created_at)
      SELECT c.id, c.issue_id,
             (ARRAY['pass','fail','pass','fail','pass','fail','pass','fail','short','skipped'])[1 + floor(random() * 10)::int],
             'agent', k.kind,
             CASE WHEN k.kind = 'commit' THEN (${sql.param([...SHAS, SHAS[0], SHAS[0], SHAS[1]])}::text[])[1 + floor(random() * 6)::int] END,
             CASE WHEN k.kind = 'runtime' THEN (${sql.param(RUNTIMES)}::text[])[1 + floor(random() * 3)::int] END,
             CASE WHEN k.kind = 'release' THEN '0.4.0-dev.' || (1 + floor(random() * 2)::int) END,
             CASE WHEN random() < 0.85 THEN ${ownerId}::uuid END,
             'judged ' || v,
             CASE WHEN random() < 0.05 THEN ARRAY['web'] END,
             -- either side of the builder cutover, and either side of the issue's reopen
             -- (one issue in twenty judged only before its reopen, so its criteria stand voided)
             CASE WHEN i.iss_seq % 20 = 0 THEN i.created_at + make_interval(mins => 5 - floor(random() * 120)::int)
                  WHEN random() < 0.3 THEN '2026-10-25T17:00:00Z'::timestamptz + make_interval(hours => floor(random() * 96)::int - 48)
                  ELSE i.created_at + make_interval(mins => floor(random() * 240)::int - 60) END
        FROM issue_criteria c JOIN issues i ON i.id = c.issue_id
        CROSS JOIN generate_series(1, 40) v
        CROSS JOIN LATERAL (SELECT (ARRAY['commit','commit','commit','commit','commit','commit','commit','commit','runtime','release'])[1 + floor(random() * 10 + v * 0)::int] AS kind) k
       WHERE i.project_id = ${projectId}`);
    // and on the first issue, a history where each of who recorded it decides which verdict a judge
    // stands on: a builder's pass over another's (1), an unauthored pass over an authored one (2), a
    // builder's pass before the cutover under one after it (3); the reason marks the builder's
    await tx.execute(sql`
      DELETE FROM criterion_verdicts cv USING issues i
       WHERE i.id = cv.issue_id AND i.project_id = ${projectId} AND i.iss_seq = 1`);
    await tx.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind,
                                      commit_sha, author_user_id, reason, created_at)
      SELECT c.id, c.issue_id, 'pass', 'agent', 'commit', ${SHAS[0]},
             CASE WHEN h.authored THEN ${ownerId}::uuid END, h.reason, h.at
        FROM issue_criteria c JOIN issues i ON i.id = c.issue_id
        JOIN (VALUES
          (1, true, 'by builder', now() - interval '1 minute'),
          (1, true, 'judged', now() - interval '2 minutes'),
          (1, true, 'by builder', now() - interval '3 minutes'),
          (2, false, 'judged', now() - interval '1 minute'),
          (2, true, 'judged', now() - interval '2 minutes'),
          (2, false, 'judged', now() - interval '3 minutes'),
          (3, true, 'by builder', '2026-10-25T19:00:00Z'::timestamptz),
          (3, true, 'by builder', '2026-10-25T16:00:00Z'::timestamptz)
        ) AS h(n, authored, reason, at) ON h.n = c.n
       WHERE i.project_id = ${projectId} AND i.iss_seq = 1`);
  });
  // a reopen inside the history of one issue in three, so verdicts fall either side of it
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      SELECT 'issue', i.id, m.f, m.t, 'user', 'human', ${ownerId}, 'test', i.created_at + make_interval(mins => 30 + m.n)
        FROM issues i CROSS JOIN (VALUES (0, 'closed', 'reopen'), (1, 'reopen', 'in_progress')) AS m(n, f, t)
       WHERE i.project_id = ${projectId} AND i.iss_seq % 3 = 0 AND i.iss_seq % 10 <> 0`);
  });
  // the builder facts the writes marked owed are written, then a builder's verdicts set among them,
  // as the model would hold them where runs had built the issues
  await drainStaleBuilderFacts(db, 10_000);
  await db.execute(sql`SELECT setseed(0.57)`);
  await db.execute(sql`
    UPDATE verdict_builder_facts vb SET by_builder = random() < 0.3
      FROM issues i WHERE i.id = vb.issue_id AND i.project_id = ${projectId} AND i.iss_seq <> 1`);
  await db.execute(sql`
    UPDATE verdict_builder_facts vb SET by_builder = cv.reason = 'by builder'
      FROM criterion_verdicts cv JOIN issues i ON i.id = cv.issue_id
     WHERE cv.id = vb.verdict_id AND i.project_id = ${projectId} AND i.iss_seq = 1`);
  const builders = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE vb.by_builder)::int AS n FROM verdict_builder_facts vb
      JOIN issues i ON i.id = vb.issue_id WHERE i.project_id = ${projectId}`)) as unknown as {
    n: number;
  }[];
  expect(builders[0]?.n).toBeGreaterThan(0);
}, 120_000);

afterAll(() => {
  unplant?.();
  everyVerdictRead.on = false;
});

/** What `read` answers with the newest verdict of each class, and with every verdict. */
async function both<T>(read: () => Promise<T>): Promise<{ classes: T; every: T }> {
  everyVerdictRead.on = false;
  const classes = await read();
  everyVerdictRead.on = true;
  try {
    return { classes, every: await read() };
  } finally {
    everyVerdictRead.on = false;
  }
}

const verdictOf = (v: StandingIssueCriterion | StandingIssueCriterion['beforeReopen']) =>
  v && {
    verdict: v.verdict,
    verdictAt: v.verdictAt,
    note: v.note,
    files: v.files,
    identity: v.identity,
    byBuilder: v.byBuilder,
    authored: v.authored,
    recordedAt: v.recordedAt,
    covers: v.covers,
  };

/** Each criterion as its readers read it: its own verdict, each judge's, the void and what is named. */
function asRead(rows: readonly StandingIssueCriterion[]) {
  const judges: (VerifiedJudge | null)[] = [null, 'builder', 'independent'];
  return rows.map((ic) => {
    const history = [ic, ...(ic.earlier ?? [])];
    const named = [...history, ...(ic.beforeReopen ? [ic.beforeReopen] : [])]
      .filter((v) => v.verdict !== null && v.identity)
      .map((v) => JSON.stringify(v.identity));
    return {
      issueId: ic.issueId,
      n: ic.n,
      liveOnly: ic.liveOnly ?? false,
      own: verdictOf(ic),
      beforeReopen: verdictOf(ic.beforeReopen) ?? null,
      judges: judges.map((j) => verdictOf(judgesVerdict(history, j))),
      named: [...new Set(named)].sort(),
    };
  });
}

describe('a criterion read by the newest verdict of each class (ISS-1070 r6)', () => {
  it('answers each judge, the reopen and the identities as every verdict does, reading fewer', async () => {
    const ids = (
      (await db.execute(
        sql`SELECT id FROM issues WHERE project_id = ${projectId} ORDER BY iss_seq`,
      )) as unknown as { id: string }[]
    ).map((r) => r.id);
    const { classes, every } = await both(() => issueCriteriaOf(ids));
    const earlier = (rows: StandingIssueCriterion[]) =>
      rows.reduce((n, r) => n + (r.earlier?.length ?? 0), 0);
    // the history is long enough that the classes read fewer verdicts than every one
    expect(earlier(classes)).toBeLessThan(earlier(every));
    expect(every.length).toBe(ids.length * 3);
    // some criteria stand across a reopen, and every judge's reading differs somewhere
    expect(every.some((ic) => ic.beforeReopen)).toBe(true);
    expect(asRead(classes)).toEqual(asRead(every));
  });

  it("answers each requirement's standing and live build as every verdict does", async () => {
    const access = await loadProjectAccess(projectId, ownerId);
    const viewer = needsYouViewerOf(access, ownerId, 'human');
    const requirements = await both(() => listRequirementsAs(viewer, projectId));
    expect(requirements.every.length).toBe(3);
    expect(requirements.classes).toEqual(requirements.every);
    const reqIds = requirements.every.map((r) => r.id);
    const live = await both(() =>
      Promise.all(reqIds.map((id) => liveBuildOfRequirement(projectId, id))),
    );
    expect(live.every.some((l) => l !== null)).toBe(true);
    expect(live.classes).toEqual(live.every);
  });
});
