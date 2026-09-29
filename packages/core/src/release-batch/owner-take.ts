// A master's run session taking a release, and what a master reads to know there is one to take.
//
// The take is by key set: a run session opened over exactly a waiting roster's issues owns that
// roster's release (ISS-1281). It is decided twice. `releaseAdoption` answers before anything is
// opened, so a declaration that cannot take the release is refused by name and the refusal is
// written where the batch state shows it. `takeReleaseOwnership` answers again inside the
// transaction that inserts the session and its leases, holding the release row, so of two masters
// declaring one roster at once the second finds it owned and rolls its whole open back.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { RUN_SESSION_ISSUE_LIMIT } from '../devices/run-session-limit.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { canonicalIssueKey, formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { wakeMastersForRelease } from '../ws/master-wake.js';
import { ReleaseRosterOverRunError } from './errors.js';
import { type OwnerBox, ownerBoxClause, readOwnerCandidates } from './owner-boxes.js';
import {
  metadataWithOwner,
  type OwnerRefusal,
  RELEASE_BRIEF_KEY,
  type ReleaseOwner,
  readBrief,
  readOwner,
  withRefusal,
} from './owner-record.js';
import { openReleaseRosters, type ReleaseRosterRow, releaseRosterIssueIds } from './queries.js';

/** One run session owns a release, so a roster larger than one carries is never cut. */
export function assertRosterFitsOneRun(named: number): void {
  if (named > RUN_SESSION_ISSUE_LIMIT) {
    throw new ReleaseRosterOverRunError(named, RUN_SESSION_ISSUE_LIMIT);
  }
}

/**
 * Hand a cut release to its project's masters: the brief goes on the run before any master is
 * woken, so `pending` never lists a roster a master could take without the prompt it hands on.
 */
export async function handToMasters(args: {
  projectId: string;
  releaseRunId: string;
  brief: string;
}): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({
      metadata: sql`jsonb_set(coalesce(${pipelineRuns.metadata}, '{}'::jsonb), ${`{${RELEASE_BRIEF_KEY}}`}::text[], to_jsonb(${args.brief}::text))`,
      updatedAt: new Date(),
    })
    .where(sql`${pipelineRuns.id} = ${args.releaseRunId}`);
  await wakeMastersForRelease({ projectId: args.projectId, releaseRunId: args.releaseRunId });
}

export class ReleaseOwnershipRefusedError extends Error {
  readonly code = 'RELEASE_OWNERSHIP_REFUSED';
  constructor(
    public readonly releaseRunId: string,
    message: string,
  ) {
    super(`RELEASE_OWNERSHIP_REFUSED: ${message}`);
    this.name = 'ReleaseOwnershipRefusedError';
  }
}

const keysOf = (row: ReleaseRosterRow): string[] =>
  row.seqs.map((s) => canonicalIssueKey(Number(s)));

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k));

async function recordRefusal(runId: string, refusal: OwnerRefusal): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT metadata FROM pipeline_runs WHERE id = ${runId} FOR UPDATE
      `)) as unknown as Array<{ metadata: unknown }>;
      const owner = readOwner(rows[0]?.metadata, runId);
      if (!owner) return;
      await tx
        .update(pipelineRuns)
        .set({ metadata: metadataWithOwner(withRefusal(owner, refusal)), updatedAt: new Date() })
        .where(sql`${pipelineRuns.id} = ${runId}`);
    });
  } catch (err) {
    logger.warn({ err, runId }, 'release-batch: could not record a refused take on the batch');
  }
}

function describeOwner(owner: ReleaseOwner): string {
  if (owner.state === 'owned') {
    return `already owned by run session ${owner.sessionId} on \`${owner.deviceName ?? owner.deviceId}\`, taken at ${owner.takenAt}`;
  }
  return `no longer waiting for an owner (${owner.state}${owner.why ? `: ${owner.why}` : ''})`;
}

async function refuse(
  runId: string,
  device: { deviceId: string; deviceName: string | null },
  message: string,
): Promise<never> {
  await recordRefusal(runId, {
    at: new Date().toISOString(),
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    reason: message,
  });
  throw new ReleaseOwnershipRefusedError(runId, message);
}

function labelOf(metadata: unknown): string | null {
  const label = (metadata as { releaseRunner?: { label?: unknown } } | null)?.releaseRunner?.label;
  return typeof label === 'string' && label.length > 0 ? label : null;
}

export interface ReleaseAdoption {
  releaseRunId: string;
  deviceName: string;
  /** Whether the box taking it carries the label the release prefers, or no label is preferred. */
  preferenceMet: boolean;
}

/**
 * Whether a run session over `issueKeys` on this box takes a release, refusing by name the one that
 * touches a waiting roster and cannot. `null` where no open release claims any of these issues.
 */
export async function releaseAdoption(args: {
  projectId: string;
  deviceId: string;
  issueKeys: string[];
}): Promise<ReleaseAdoption | null> {
  const touching = (await openReleaseRosters(db, args.projectId)).filter((r) =>
    keysOf(r).some((k) => args.issueKeys.includes(k)),
  );
  const [row, second] = touching;
  if (!row) return null;
  const label = labelOf(row.metadata);
  const candidates = await readOwnerCandidates(args.projectId, label);
  const box = candidates.boxes.find((b) => b.deviceId === args.deviceId);
  const device = { deviceId: args.deviceId, deviceName: box?.deviceName ?? null };
  if (second) {
    await refuse(
      row.id,
      device,
      `these issues are claimed by two releases (${row.id}, ${second.id}); a run session takes one release, over exactly its roster`,
    );
  }
  const roster = keysOf(row);
  const owner = readOwner(row.metadata, row.id);
  if (!owner) {
    await refuse(
      row.id,
      device,
      `release ${row.id} was cut before a release was owned by a run session, and its job owns it; declare work over issues no release claims`,
    );
  }
  if (!sameSet(roster, args.issueKeys)) {
    await refuse(
      row.id,
      device,
      `these issues belong to release ${row.id}, and a run session takes a release over exactly its roster: declare all of ${roster.join(', ')} and nothing else`,
    );
  }
  if (owner && owner.state !== 'awaiting') {
    await refuse(row.id, device, `release ${row.id} is ${describeOwner(owner)}`);
  }
  if (!candidates.eligible.some((b) => b.deviceId === args.deviceId)) {
    await refuse(row.id, device, notEligible(box, candidates.eligible, label));
  }
  return {
    releaseRunId: row.id,
    deviceName: box?.deviceName ?? args.deviceId,
    preferenceMet: label === null || box?.labelled === true,
  };
}

function notEligible(
  box: OwnerBox | undefined,
  eligible: OwnerBox[],
  label: string | null,
): string {
  if (!box) return 'this box has no runner on the project, so it cannot own its release';
  if (box.reason !== null) return `this box cannot own the release now — ${ownerBoxClause(box)}`;
  const named = eligible.map((b) => `\`${b.deviceName}\``).join(', ');
  return `this release prefers a box labelled \`${label}\`, and ${named} carries it and may take it; \`${box.deviceName}\` does not`;
}

/**
 * Inside the open's own transaction: hold the release row, take it only if it is still waiting,
 * and write the owner before the transaction commits. Throws to roll the whole open back.
 */
export async function takeReleaseOwnership(
  tx: Tx,
  args: {
    releaseRunId: string;
    deviceId: string;
    deviceName: string;
    sessionId: string;
    runId: string;
    preferenceMet: boolean;
  },
): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT metadata, status FROM pipeline_runs WHERE id = ${args.releaseRunId} FOR UPDATE
  `)) as unknown as Array<{ metadata: unknown; status: string }>;
  const row = rows[0];
  const owner = row ? readOwner(row.metadata, args.releaseRunId) : null;
  if (!row || !owner || (row.status !== 'running' && row.status !== 'paused')) {
    throw new ReleaseOwnershipRefusedError(
      args.releaseRunId,
      `release ${args.releaseRunId} is not open any more, so nothing is waiting to be taken`,
    );
  }
  if (owner.state !== 'awaiting') {
    throw new ReleaseOwnershipRefusedError(
      args.releaseRunId,
      `release ${args.releaseRunId} is ${describeOwner(owner)}`,
    );
  }
  const taken: ReleaseOwner = {
    ...owner,
    state: 'owned',
    takenAt: new Date().toISOString(),
    deviceId: args.deviceId,
    deviceName: args.deviceName,
    sessionId: args.sessionId,
    runId: args.runId,
  };
  await tx.execute(sql`
    UPDATE pipeline_runs
       SET metadata = jsonb_set(${metadataWithOwner(taken)}, '{releaseRunner,preferenceMet}',
                                to_jsonb(${args.preferenceMet}::boolean), true),
           updated_at = now()
     WHERE id = ${args.releaseRunId}
  `);
}

/** A refusal thrown inside the open, recorded once the open has rolled back. */
export async function noteTakeRefused(
  err: ReleaseOwnershipRefusedError,
  device: { deviceId: string; deviceName: string | null },
): Promise<void> {
  await recordRefusal(err.releaseRunId, {
    at: new Date().toISOString(),
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    reason: err.message.replace(/^RELEASE_OWNERSHIP_REFUSED: /, ''),
  });
}

export interface PendingRelease {
  runId: string;
  version: string | null;
  /** The issues to declare, exactly, in this project's own spelling. */
  issueKeys: string[];
  since: string;
  deadlineAt: string;
  /** The boxes that may take it now, and what stops every other one. */
  mayTake: Array<{ deviceId: string; deviceName: string }>;
  boxes: Array<{ deviceName: string; clause: string }>;
  preferredLabel: string | null;
  /** The prompt to hand the release subagent, verbatim. */
  brief: string;
}

/** Every release of this project waiting for a master to take it, oldest first. */
export async function pendingReleases(projectId: string): Promise<PendingRelease[]> {
  const rows = await openReleaseRosters(db, projectId);
  const prefix = await activeIssuePrefix(projectId);
  const out: PendingRelease[] = [];
  for (const row of rows) {
    const owner = readOwner(row.metadata, row.id);
    const brief = readBrief(row.metadata);
    if (owner?.state !== 'awaiting' || !brief) continue;
    const label = labelOf(row.metadata);
    const candidates = await readOwnerCandidates(projectId, label);
    out.push({
      runId: row.id,
      version: row.release_version,
      issueKeys: row.seqs.map((s) => formatIssueRef(prefix, Number(s))),
      since: owner.since,
      deadlineAt: owner.deadlineAt,
      mayTake: candidates.eligible.map((b) => ({ deviceId: b.deviceId, deviceName: b.deviceName })),
      boxes: candidates.boxes.map((b) => ({ deviceName: b.deviceName, clause: ownerBoxClause(b) })),
      preferredLabel: label,
      brief,
    });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * The issue ids of every waiting roster this box may take, across the projects it serves — what
 * the admissible list adds so a box with a release to take places and nudges its master.
 */
export async function takeableRosterIssueIds(args: {
  deviceId: string;
  projectId?: string | undefined;
}): Promise<string[]> {
  const projectFilter = args.projectId ? sql`AND r.project_id = ${args.projectId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.project_id
      FROM runners r
     WHERE r.device_id = ${args.deviceId}
       ${projectFilter}
  `)) as unknown as Array<{ project_id: string }>;
  const ids: string[] = [];
  for (const { project_id: projectId } of rows) {
    for (const pending of await pendingReleases(projectId)) {
      if (!pending.mayTake.some((b) => b.deviceId === args.deviceId)) continue;
      ids.push(...(await releaseRosterIssueIds(pending.runId)));
    }
  }
  return ids;
}
