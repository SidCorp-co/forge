/**
 * The `runner_releases` row: opening one, moving it, and settling it exactly
 * once. ISS-1075.
 *
 * Every write past the open is CONDITIONAL on the row still being non-terminal,
 * and each answers how many rows it moved. That is what makes a re-delivered
 * `workflow_run`, a re-run of a build already reported, and the deadline pass
 * racing a delivery all write nothing rather than settling a release twice —
 * and it is why these are statements here rather than a read-modify-write in
 * the caller, which two deliveries milliseconds apart would both win.
 */

import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type RunnerReleasePublication,
  type RunnerReleaseRow,
  type RunnerReleaseStep,
  type RunnerReleaseTagState,
  runnerReleases,
} from '../../db/schema-runner-release.js';

export type { RunnerReleaseRow };

export interface OpenArgs {
  projectId: string;
  bindingId: string;
  repository: string;
  version: string;
  tag: string;
  requestedById: string | null;
  deadlineAt: Date;
}

/** A row this call opened, or the standing row that would not give way. */
export type OpenOutcome =
  | { opened: RunnerReleaseRow; held: null }
  | { opened: null; held: RunnerReleaseRow };

// cm:guard the re-arm's WHERE is the whole of the retry rule, and it is in the STATEMENT rather than in a branch above it: a read-then-insert would let two calls both read the row and both cut. Both halves are load-bearing. `settled_at IS NOT NULL` is what stops a second start seizing an attempt still running — without it two overlapping calls share one row, and one of them settles `absent` while the other has a create request in flight. `tag_state IN ('unread','absent')` is what stops a second attempt at a tag that exists or whose create went unanswered: that would either fail on GitHub's own 422 or, worse, succeed against a tag somebody else cut.
export async function openRunnerRelease(args: OpenArgs): Promise<OpenOutcome> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO runner_releases
      (project_id, binding_id, repository, version, tag, requested_by_id, deadline_at)
    VALUES (${args.projectId}, ${args.bindingId}, ${args.repository}, ${args.version},
            ${args.tag}, ${args.requestedById}, ${args.deadlineAt.toISOString()})
    ON CONFLICT (project_id, tag) DO UPDATE SET
      binding_id = EXCLUDED.binding_id,
      repository = EXCLUDED.repository,
      requested_by_id = EXCLUDED.requested_by_id,
      deadline_at = EXCLUDED.deadline_at,
      status = 'preflight',
      step = 'resolve_repository',
      publication = 'unread',
      publication_detail = NULL,
      commit_sha = NULL,
      workflow_run_id = NULL,
      workflow_url = NULL,
      build_conclusion = NULL,
      release_url = NULL,
      failure = NULL,
      readings = '[]'::jsonb,
      tag_state = 'unread',
      started_at = now(),
      tag_cut_at = NULL,
      build_reported_at = NULL,
      settled_at = NULL,
      updated_at = now()
    WHERE runner_releases.settled_at IS NOT NULL
      AND runner_releases.tag_state IN ('unread', 'absent')
    RETURNING id
  `);
  // cm:guard the statement returns the ID and the ROW is read back through drizzle, because
  // `db.execute` hands back the driver's own snake_case object: a `RETURNING *` typed as
  // `RunnerReleaseRow` compiles, and every camelCase field a caller reads off it — `tagState`,
  // `commitSha`, `step` — is `undefined` at runtime. That shape passed the whole unit suite, which
  // mocks this module, and was caught by the first integration case that read a column back.
  const openedId = rows[0]?.id;
  if (openedId) {
    const opened = await findById(openedId);
    if (opened) return { opened, held: null };
  }
  const held = await findByProjectAndTag(args.projectId, args.tag);
  if (!held) {
    throw new Error(
      `runner-release: the insert for ${args.tag} neither opened a row nor found the one it conflicted with`,
    );
  }
  return { opened: null, held };
}

export async function findByProjectAndTag(
  projectId: string,
  tag: string,
): Promise<RunnerReleaseRow | null> {
  const [row] = await db
    .select()
    .from(runnerReleases)
    .where(and(eq(runnerReleases.projectId, projectId), eq(runnerReleases.tag, tag)))
    .limit(1);
  return row ?? null;
}

/** The row a delivery names: its own binding, and the tag the build ran for. */
export async function findByBindingAndTag(
  bindingId: string,
  tag: string,
): Promise<RunnerReleaseRow | null> {
  const [row] = await db
    .select()
    .from(runnerReleases)
    .where(and(eq(runnerReleases.bindingId, bindingId), eq(runnerReleases.tag, tag)))
    .limit(1);
  return row ?? null;
}

export async function findById(id: string): Promise<RunnerReleaseRow | null> {
  const [row] = await db.select().from(runnerReleases).where(eq(runnerReleases.id, id)).limit(1);
  return row ?? null;
}

export async function listForProject(projectId: string, limit = 50): Promise<RunnerReleaseRow[]> {
  return db
    .select()
    .from(runnerReleases)
    .where(eq(runnerReleases.projectId, projectId))
    .orderBy(desc(runnerReleases.startedAt))
    .limit(limit);
}

/** One line onto the row's readings, whatever the outcome of the step it describes. */
export async function appendReading(id: string, line: string): Promise<void> {
  await db.execute(sql`
    UPDATE runner_releases
       SET readings = readings || ${JSON.stringify([line])}::jsonb, updated_at = now()
     WHERE id = ${id}
  `);
}

export interface AdvanceArgs {
  step?: RunnerReleaseStep;
  status?: 'preflight' | 'cutting' | 'building';
  tagState?: RunnerReleaseTagState;
  commitSha?: string;
  tagCutAt?: Date;
  workflowRunId?: string;
  workflowUrl?: string;
}

// cm:guard non-terminal only, and it answers `false` rather than throwing on a terminal row: the deadline pass can settle a release between two steps of a sequence still running, and that sequence finding its row already failed is an ordinary race, not an error.
export async function advance(id: string, args: AdvanceArgs): Promise<boolean> {
  const sets = [sql`updated_at = now()`];
  if (args.step) sets.push(sql`step = ${args.step}`);
  if (args.status) sets.push(sql`status = ${args.status}`);
  if (args.tagState) sets.push(sql`tag_state = ${args.tagState}`);
  if (args.commitSha) sets.push(sql`commit_sha = ${args.commitSha}`);
  if (args.tagCutAt) sets.push(sql`tag_cut_at = ${args.tagCutAt.toISOString()}`);
  if (args.workflowRunId) sets.push(sql`workflow_run_id = ${args.workflowRunId}`);
  if (args.workflowUrl) sets.push(sql`workflow_url = ${args.workflowUrl}`);
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE runner_releases SET ${sql.join(sets, sql`, `)}
     WHERE id = ${id} AND settled_at IS NULL
     RETURNING id
  `);
  return rows.length > 0;
}

export interface SettleFailedArgs {
  step: RunnerReleaseStep;
  failure: string;
  /** Settle only while the row still reads as it did when the caller read it. */
  ifUnchanged?: { step: RunnerReleaseStep; tagState: RunnerReleaseTagState };
  tagState?: RunnerReleaseTagState;
  publication?: RunnerReleasePublication;
  publicationDetail?: string;
  buildConclusion?: string;
  workflowRunId?: string;
  workflowUrl?: string;
  releaseUrl?: string;
  buildReportedAt?: Date;
}

/** Fail the release, naming the step and what is true on the repository. Once. */
export async function settleFailed(id: string, args: SettleFailedArgs): Promise<boolean> {
  const sets = [
    sql`status = 'failed'`,
    sql`step = ${args.step}`,
    sql`failure = ${args.failure}`,
    sql`settled_at = now()`,
    sql`updated_at = now()`,
  ];
  if (args.tagState) sets.push(sql`tag_state = ${args.tagState}`);
  if (args.publication) sets.push(sql`publication = ${args.publication}`);
  if (args.publicationDetail) sets.push(sql`publication_detail = ${args.publicationDetail}`);
  if (args.buildConclusion) sets.push(sql`build_conclusion = ${args.buildConclusion}`);
  if (args.workflowRunId) sets.push(sql`workflow_run_id = ${args.workflowRunId}`);
  if (args.workflowUrl) sets.push(sql`workflow_url = ${args.workflowUrl}`);
  if (args.releaseUrl) sets.push(sql`release_url = ${args.releaseUrl}`);
  if (args.buildReportedAt)
    sets.push(sql`build_reported_at = ${args.buildReportedAt.toISOString()}`);
  // cm:guard `ifUnchanged` is what the deadline pass settles under, and it is a condition rather than a re-read because the row it selected can move between the SELECT and this UPDATE: the sequence it is racing advances `cut_tag`/`unknown` over a `resolve_commit`/`unread` reading, and a settle without this clause writes the OLD step back over the new one together with a failure sentence saying the tag does not exist — a terminal row describing a snapshot that is no longer true.
  const guard = args.ifUnchanged
    ? sql` AND step = ${args.ifUnchanged.step} AND tag_state = ${args.ifUnchanged.tagState}`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE runner_releases SET ${sql.join(sets, sql`, `)}
     WHERE id = ${id} AND settled_at IS NULL${guard}
     RETURNING id
  `);
  return rows.length > 0;
}

export interface SettlePublishedArgs {
  publicationDetail: string;
  buildConclusion: string;
  workflowRunId: string;
  workflowUrl: string | null;
  releaseUrl: string | null;
  buildReportedAt: Date;
}

// cm:guard `tag_state = 'present'` is written HERE and not assumed: `runner_releases_published_chk` refuses the row otherwise, and that refusal is the point — a release cannot read published over a tag nothing confirmed.
export async function settlePublished(id: string, args: SettlePublishedArgs): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE runner_releases
       SET status = 'published',
           step = 'confirm_release',
           tag_state = 'present',
           publication = 'published',
           publication_detail = ${args.publicationDetail},
           build_conclusion = ${args.buildConclusion},
           workflow_run_id = ${args.workflowRunId},
           workflow_url = ${args.workflowUrl},
           release_url = ${args.releaseUrl},
           build_reported_at = ${args.buildReportedAt.toISOString()},
           settled_at = now(),
           updated_at = now()
     WHERE id = ${id} AND settled_at IS NULL
     RETURNING id
  `);
  return rows.length > 0;
}

// cm:guard this is the ONE lookup by commit on this path and it may never attribute a delivery — it exists so a build Forge cannot attribute is written somewhere a reader of that release will meet it, rather than only into a log. A commit does not name a tag: two `runner-v*` tags can point at one, which is exactly why `runner-release-events.ts` settles on the tag alone.
export async function inFlightAtCommit(
  bindingId: string,
  commitSha: string,
): Promise<RunnerReleaseRow[]> {
  return db
    .select()
    .from(runnerReleases)
    .where(
      and(
        eq(runnerReleases.bindingId, bindingId),
        eq(runnerReleases.commitSha, commitSha),
        isNull(runnerReleases.settledAt),
      ),
    )
    .limit(25);
}

/** Every release still in flight whose own clock has run out. */
export async function overdueReleases(now: Date, limit = 100): Promise<RunnerReleaseRow[]> {
  return db
    .select()
    .from(runnerReleases)
    .where(and(isNull(runnerReleases.settledAt), lte(runnerReleases.deadlineAt, now)))
    .orderBy(runnerReleases.deadlineAt)
    .limit(limit);
}
