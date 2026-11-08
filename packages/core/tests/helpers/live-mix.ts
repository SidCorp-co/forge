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
import { createTestProject, createTestUser } from './factories.js';
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
}

/** forge-dev's mix, forge first. */
export const LIVE_MIX: readonly Kind[] = [
  { scale: FORGE, deploys: 'coolify', onLand: true, linkedFeedback: true },
  { scale: SMALL, deploys: 'offline', storefront: true },
  { scale: SMALL, deploys: 'coolify', storefront: true, onLand: true },
  { scale: { ...SMALL, batches: 3 }, changeRequests: true },
  { scale: TINY, deploys: 'offline' },
  { scale: null },
  { scale: { ...SMALL, live: false, states: false }, outsideGit: true },
  { scale: SMALL, deploys: 'coolify', onLand: true, linkedFeedback: true },
  { scale: MID, deploys: 'offline', linkedFeedback: true },
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
  const agentId = (await createTestUser({ verified: true })).id;
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
    // an agent filed most of it: the person owns one issue in seven and one item in five
    await db.execute(
      sql`UPDATE issues SET created_by_id = ${agentId} WHERE project_id = ${id} AND iss_seq % 7 <> 0`,
    );
    await db.execute(
      sql`UPDATE feedback SET reported_by = ${agentId} WHERE project_id = ${id} AND fb_seq % 5 <> 0`,
    );
    ids.push(id);
  }
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

/** A project with no repository whose closed issues landed outside git, each naming what changed. */
async function landOutsideGit(projectId: string, ownerId: string): Promise<void> {
  await seedProjectDocument(projectId, ownerId, { environments: {}, source: { type: 'none' } });
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = NULL,
           merged_artifacts = jsonb_build_array(jsonb_build_object('surface', 'config', 'ref', 'setting ' || iss_seq, 'change', 'changed'))
     WHERE project_id = ${projectId} AND merged_at IS NOT NULL`);
}
