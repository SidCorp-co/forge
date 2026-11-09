// Fourteen projects of the kinds a person reads side by side on forge-dev (ISS-1070 r15): one the
// size of forge, storefronts with and without a deploy binding, projects that deploy on land (an
// automatic release mode) beside ones a person cuts, recorded landings with no production, a small
// one, an empty one, one with only the plain seed, and feedback pointing at a workflow, a release
// and a requirement revision. The twelve wired projects of `me-reads-flat-by-shape-e2e.test.ts` are
// one kind each read alike, so a batch every project reaches at the same step looked flat there,
// while forge-dev's mix sent it four to six times a read. Most rows are an agent's, as on forge-dev:
// the person reading owns an issue or a feedback item here and there, not every one.

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { createTestProject, createTestUser } from './factories.js';
import { peopleAsLive } from './live-mix-people.js';
import {
  askAboutRequirement,
  baseDesigns,
  proposeDesignChanges,
  stewardFired,
} from './live-mix-waits.js';
import { wireLive, wireStorefront } from './live-wiring.js';
import { seedProductionDeployTrigger, seedProjectDocument } from './release-world.js';
import { type Scale, seedAtScale } from './scale-world.js';

const SMALL: Scale = {
  requirements: 6,
  criteriaPerRequirement: 3,
  issues: 40,
  criteriaPerIssue: 2,
  verdictsPerCriterion: 2,
  releases: 10,
  feedback: 12,
  activityPerIssue: 2,
  open: 12,
  live: true,
  states: true,
};
const TINY: Scale = { ...SMALL, requirements: 2, issues: 6, open: 3, releases: 2, feedback: 3 };
const MID: Scale = { ...SMALL, requirements: 12, issues: 80, open: 20, releases: 15, feedback: 30 };
const FORGE: Scale = {
  ...SMALL,
  requirements: 30,
  issues: 200,
  open: 30,
  releases: 30,
  feedback: 60,
};

/** One project of the mix: its rows, how it is wired, and what its feedback points at. */
interface Kind {
  scale: Scale | null;
  /** Production through a deploy binding Coolify answers, one that reaches no network, or none. */
  deploys?: 'coolify' | 'offline';
  /** Production deploys on land: the automatic release mode. */
  onLand?: boolean;
  storefront?: boolean;
  /** Feedback pointing at a workflow, a release and a requirement revision. */
  linkedFeedback?: boolean;
  /** No production; work is delivered through change requests a person approves. */
  changeRequests?: boolean;
  /** No repository: work lands outside git, each closed issue's merge naming its artifacts. */
  outsideGit?: boolean;
  /** Verdicts recorded at the requirement itself, each naming the commit it was judged on. */
  judgedAtRequirement?: boolean;
  /** Open issues held by closed blockers whose design is not approved yet: blockers no open list reads. */
  heldFromOutside?: boolean;
  /** Shipped items whose release sent their reporter its notice, and a person wrote them since. */
  toldShipped?: boolean;
  /** A cleanup schedule whose newest fire ran a session that left the steward's report. */
  stewardFires?: boolean;
  /** Open questions a person owes about a requirement, one asked on no item and one on an issue. */
  askedAboutRequirement?: boolean;
  /** Designs that declare a base (`basedOn`), pinned at the base's approved revision. */
  basedDesigns?: boolean;
  /** Proposed design changes on workflows, waiting on a person. */
  designChanges?: boolean;
}

/** forge-dev's mix, forge first. */
export const LIVE_MIX: readonly Kind[] = [
  {
    scale: FORGE,
    deploys: 'coolify',
    onLand: true,
    linkedFeedback: true,
    judgedAtRequirement: true,
    heldFromOutside: true,
    toldShipped: true,
    stewardFires: true,
    basedDesigns: true,
    designChanges: true,
  },
  {
    scale: SMALL,
    deploys: 'offline',
    storefront: true,
    stewardFires: true,
    askedAboutRequirement: true,
  },
  {
    scale: SMALL,
    deploys: 'coolify',
    storefront: true,
    onLand: true,
    stewardFires: true,
    basedDesigns: true,
  },
  { scale: { ...SMALL, batches: 3 }, changeRequests: true },
  { scale: TINY, deploys: 'offline' },
  { scale: null },
  { scale: { ...SMALL, live: false, states: false }, outsideGit: true },
  {
    scale: SMALL,
    deploys: 'coolify',
    onLand: true,
    linkedFeedback: true,
    toldShipped: true,
    stewardFires: true,
    askedAboutRequirement: true,
    designChanges: true,
  },
  {
    scale: MID,
    deploys: 'offline',
    linkedFeedback: true,
    judgedAtRequirement: true,
    stewardFires: true,
    askedAboutRequirement: true,
    basedDesigns: true,
  },
  { scale: { ...SMALL, batches: 2 } },
  { scale: TINY, deploys: 'coolify', onLand: true },
  { scale: null, deploys: 'offline' },
  { scale: SMALL, deploys: 'coolify', onLand: true, linkedFeedback: true },
  { scale: MID },
];

/**
 * Seeds {@link LIVE_MIX} in `orgId`, each project wired into `ecosystemId` where it deploys, and
 * answers the projects' ids, forge's first. `coolify` and `autoflow` are the stubs' base addresses.
 */
export async function seedLiveMix(input: {
  ownerId: string;
  orgId: string;
  ecosystemId: string;
  coolify: string;
  autoflow: string;
}): Promise<string[]> {
  const { ownerId, orgId, ecosystemId } = input;
  const ids: string[] = [];
  for (const kind of LIVE_MIX) {
    const id = kind.scale
      ? await seedAtScale(ownerId, kind.scale, { orgId })
      : (await createTestProject(ownerId, { orgId })).id;
    if (kind.deploys)
      await wireLive(
        id,
        ownerId,
        ecosystemId,
        kind.deploys === 'coolify' ? input.coolify : undefined,
      );
    if (kind.onLand) await seedProductionDeployTrigger(id, ownerId, 'on-land');
    if (kind.changeRequests)
      await seedProjectDocument(id, ownerId, {
        environments: {},
        extra: { release: { approval: { required: true }, changeRequests: true } },
      });
    if (kind.outsideGit) await landOutsideGit(id, ownerId);
    if (kind.storefront) await wireStorefront(id, ownerId, input.autoflow);
    if (kind.linkedFeedback) await linkFeedback(id);
    if (kind.judgedAtRequirement) await judgeAtRequirement(id);
    if (kind.heldFromOutside) await holdFromOutside(id, ownerId);
    if (kind.toldShipped) await tellShipped(id);
    if (kind.stewardFires) await stewardFired(id, ownerId);
    if (kind.askedAboutRequirement) await askAboutRequirement(id);
    if (kind.basedDesigns) await baseDesigns(id);
    if (kind.designChanges) await proposeDesignChanges(id);
    ids.push(id);
  }
  await peopleAsLive(ids);
  await db.execute(sql`ANALYZE`);
  return ids;
}

/**
 * Points three of the project's untriaged feedback items at a workflow, a release and a requirement
 * revision proposed from a suggestion, as forge's design and release feedback does.
 */
async function linkFeedback(projectId: string): Promise<void> {
  await db.execute(sql`
    UPDATE feedback f SET where_seen = NULL,
           workflow_id = (SELECT w.id FROM project_workflows w WHERE w.project_id = f.project_id ORDER BY w.flow LIMIT 1)
     WHERE f.project_id = ${projectId} AND f.fb_seq = 3
       AND EXISTS (SELECT 1 FROM project_workflows w WHERE w.project_id = f.project_id)`);
  await db.execute(sql`
    UPDATE feedback f SET where_seen = NULL,
           release_run_id = (SELECT r.id FROM pipeline_runs r WHERE r.project_id = f.project_id
                               AND r.release_version IS NOT NULL ORDER BY r.release_released_at DESC LIMIT 1)
     WHERE f.project_id = ${projectId} AND f.fb_seq = 5`);
  await db.execute(sql`
    UPDATE feedback f SET status = 'triaged', route = 'revision', answer = NULL, duplicate_of = NULL,
           routed_requirement_id = NULL,
           routed_suggestion_id = (SELECT s.id FROM suggestions s WHERE s.project_id = f.project_id
                                     AND s.kind = 'breakdown' LIMIT 1)
     WHERE f.project_id = ${projectId} AND f.fb_seq = 7
       AND EXISTS (SELECT 1 FROM suggestions s WHERE s.project_id = f.project_id AND s.kind = 'breakdown')`);
}

/**
 * A verdict at the requirement itself on every requirement's first criterion, as forge-dev's judges
 * record them (perf-cleanup-1108): each names a release's commit, one in three a commit no release
 * names, so every requirement's build is weighed on its own verdicts (`standing-live-build.ts:liveBuildsOf`).
 */
async function judgeAtRequirement(projectId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO requirement_criterion_verdicts (requirement_id, requirement_criterion_id, verdict, evidence, commit_sha, author_agency)
    SELECT DISTINCT ON (r.id) r.id, rc.id, 'pass', ARRAY['judged at the requirement'],
           CASE WHEN r.req_seq % 3 = 0 THEN md5('unreleased' || r.req_seq) || '00000000'
                ELSE rpad(md5((r.req_seq)::text), 40, '0') END,
           'agent'
      FROM requirements r JOIN requirement_criteria rc ON rc.requirement_id = r.id
     WHERE r.project_id = ${projectId}
     ORDER BY r.id, rc.code`);
}

/**
 * Three closed issues, each the design issue of its workflow's newest revision, proposed and not yet
 * approved, block an open issue: a blocker holds until its design is approved, whatever its status
 * (`issues/blocked-by.ts:blockerUnsettledSql`), so the open list follows it outside the rows it read
 * (`issues/standing-read.ts:standingRows`), as forge-dev's design issues do (ISS-1070 r19).
 */
export async function holdFromOutside(projectId: string, ownerId: string): Promise<void> {
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      WITH held AS (
        SELECT w.id AS workflow_id, w.document,
               (SELECT max(d.revision) FROM project_workflow_designs d WHERE d.workflow_id = w.id) + 1 AS revision,
               row_number() OVER (ORDER BY w.flow) AS n
          FROM project_workflows w WHERE w.project_id = ${projectId}
      ), closed AS (
        SELECT i.id, row_number() OVER (ORDER BY i.iss_seq) AS n
          FROM issues i WHERE i.project_id = ${projectId} AND i.status = 'closed'
      )
      INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, design_issue_id)
      SELECT h.workflow_id, h.revision, h.document, ${ownerId}, c.id
        FROM held h JOIN closed c ON c.n = h.n WHERE h.n <= 3`);
  });
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    SELECT ${projectId}, d.design_issue_id, o.id, 'blocks'
      FROM (SELECT design_issue_id, row_number() OVER (ORDER BY design_issue_id) AS n
              FROM project_workflow_designs pd JOIN project_workflows w ON w.id = pd.workflow_id
             WHERE w.project_id = ${projectId} AND pd.design_issue_id IS NOT NULL AND pd.decision IS NULL) d
      JOIN (SELECT i.id, row_number() OVER (ORDER BY i.iss_seq DESC) AS n
              FROM issues i WHERE i.project_id = ${projectId} AND i.status NOT IN ('closed', 'dropped')) o
        ON o.n = d.n * 5`);
}

/**
 * Each shipped item routed to an issue has its release's notice to its reporter, keyed by the run
 * that shipped it, and every other one a message a person wrote them since, as forge-dev's do: the
 * feedback list reads the notice's release and the writer's name (`feedback/ship-notice.ts`).
 */
async function tellShipped(projectId: string): Promise<void> {
  const writer = (await createTestUser({ verified: true })).id;
  await db.execute(sql`
    INSERT INTO notifications (project_id, type, kind, tier, state, title, severity, dedupe_key)
    SELECT f.project_id, 'feedback_shipped', 'task', 'ticket', 'open', 'Shipped', 'success',
           'feedback-shipped:' || f.id || ':' || r.id
      FROM feedback f
      CROSS JOIN LATERAL (SELECT p.id FROM pipeline_runs p WHERE p.project_id = f.project_id
                            AND p.release_version IS NOT NULL ORDER BY p.release_released_at DESC LIMIT 1) r
     WHERE f.project_id = ${projectId} AND f.route = 'issue' AND f.status IN ('verified', 'triaged')`);
  await db.execute(sql`
    INSERT INTO feedback_messages (project_id, feedback_id, audience, body, recipients, sent_by, sent_agency)
    SELECT f.project_id, f.id, 'reporter', 'It shipped.', ARRAY[f.reported_by], ${writer}, 'human'
      FROM feedback f
     WHERE f.project_id = ${projectId} AND f.route = 'issue' AND f.fb_seq % 2 = 0`);
}

/** A project with no repository whose closed issues landed outside git, each naming what changed. */
async function landOutsideGit(projectId: string, ownerId: string): Promise<void> {
  await seedProjectDocument(projectId, ownerId, { environments: {}, source: { type: 'none' } });
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = NULL,
           merged_artifacts = jsonb_build_array(jsonb_build_object('surface', 'config', 'ref', 'setting ' || iss_seq, 'change', 'changed'))
     WHERE project_id = ${projectId} AND merged_at IS NOT NULL`);
}
