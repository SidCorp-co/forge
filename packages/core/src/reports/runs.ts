// The runs `reports` keeps: a query is run as the asker and its run stored with its provenance and
// its frame for REPORT_RUN_KEEP_DAYS, so a block can name the read its figures came from. Both doors
// (REST and the chat tool) run through `runReport` and read back through `readReportRun`, and answer
// alike.

import type { ActorAgency, ProjectPermission } from '@forge/contracts/permissions';
import {
  REPORT_RUN_KEEP_DAYS,
  type ReportFrame,
  type ReportRefusalCode,
  type ReportRun,
  type ReportRunFacts,
  type ReportSurface,
} from '@forge/contracts/report-queries';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { reportRuns } from '../db/schema-report-runs.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { refuser } from '../lib/refusal.js';
import { requireHeld } from '../permissions/index.js';
import { type ReportAsker, reportsPorts } from './ports.js';

export const refuse = refuser<ReportRefusalCode>('REPORT_REFUSED');

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment a run read at `asOf` stops being kept. */
export const keptUntil = (asOf: Date): Date =>
  new Date(asOf.getTime() + REPORT_RUN_KEEP_DAYS * DAY_MS);

/** The provenance a block carries of its run. */
export const factsOf = (run: ReportRun): ReportRunFacts => ({
  runId: run.runId,
  queryId: run.queryId,
  version: run.version,
  asOf: run.asOf,
});

/**
 * Runs a registered query as the asker through `surface`, stores the run, and answers it with its
 * frame passed through the project's data policy. A query not offered on the surface, or of a class
 * no egress surface is declared for, is refused before anything is read.
 */
export async function runReport(args: {
  projectId: string;
  queryId: string;
  params: unknown;
  asker: ReportAsker;
  surface: ReportSurface;
  now?: Date;
}): Promise<ReportRun> {
  const ports = reportsPorts();
  const descriptor = ports.describeQuery(args.queryId);
  if (!descriptor.surfaces.includes(args.surface)) {
    throw refuse(
      'REPORT_QUERY_NOT_ON_SURFACE',
      `report query "${args.queryId}" is offered on ${descriptor.surfaces.join(', ')}, not on ${args.surface}`,
      '/queryId',
    );
  }
  if (descriptor.egress !== 'product') {
    throw new Error(
      `report query "${args.queryId}" is ${descriptor.egress}-class and no egress surface is declared for it; add the surface before registering it`,
    );
  }
  const run = await ports.runQuery({
    projectId: args.projectId,
    queryId: args.queryId,
    params: args.params,
    asker: args.asker,
    ...(args.now ? { now: args.now } : {}),
  });
  await recordReportRun(run, descriptor.permission);
  const frame: ReportFrame = await egressForRequest(
    args.asker.agency,
    args.projectId,
    'requirement',
    run.frame,
    `the report query ${args.queryId}`,
  );
  return { ...run, frame };
}

/** Stores one run with its provenance; it is kept REPORT_RUN_KEEP_DAYS from its read. */
export async function recordReportRun(
  run: ReportRun,
  permission: ProjectPermission,
): Promise<void> {
  const asOf = new Date(run.asOf);
  await db.insert(reportRuns).values({
    id: run.runId,
    projectId: run.projectId,
    queryId: run.queryId,
    queryVersion: run.version,
    params: run.params,
    permission,
    actorKind: run.actor.kind,
    actorId: run.actor.id,
    asOf,
    expiresAt: keptUntil(asOf),
    frame: run.frame,
  });
}

/** What a stored run row says, enough to decide whether a reader may have it. */
export interface StoredRun {
  run: ReportRun;
  permission: string;
  expiresAt: Date;
}

/**
 * Whether `userId` may read this stored run at `now`, as the refusal that says why not. A run is
 * read back only by the person it was read as: its frame is what THEY may see, and another
 * member's view of the same query can differ. Past its keep it is gone, named as such.
 */
export function runReadRefusal(
  stored: StoredRun,
  userId: string,
  now: Date,
): ReturnType<typeof refuse> | null {
  const { run } = stored;
  if (run.actor.id !== userId) {
    return refuse(
      'REPORT_RUN_READ_FORBIDDEN',
      `report run ${run.runId} (${run.queryId}) was read as another member, over what they may see; only the person it was read as may read or show it. Run ${run.queryId} yourself`,
      '/runId',
    );
  }
  if (stored.expiresAt.getTime() <= now.getTime()) {
    return refuse(
      'REPORT_RUN_EXPIRED',
      `report run ${run.runId} (${run.queryId}, read at ${run.asOf}) is gone: a run is kept ${REPORT_RUN_KEEP_DAYS} days and this one expired at ${stored.expiresAt.toISOString()}. Run ${run.queryId} again for a fresh frame`,
      '/runId',
    );
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function storedRun(runId: string): Promise<StoredRun | null> {
  if (!UUID_RE.test(runId)) return null;
  const [row] = await db.select().from(reportRuns).where(eq(reportRuns.id, runId)).limit(1);
  if (!row) return null;
  return {
    permission: row.permission,
    expiresAt: row.expiresAt,
    run: {
      runId: row.id,
      queryId: row.queryId,
      version: row.queryVersion,
      params: row.params as Record<string, unknown>,
      projectId: row.projectId,
      actor: { kind: row.actorKind, id: row.actorId },
      asOf: row.asOf.toISOString(),
      frame: row.frame as ReportFrame,
    },
  };
}

/**
 * One stored run, read back by the person it was read as, who must still hold what its query
 * declared. Refused by name: a run never stored or already swept, one read as somebody else, one
 * past its keep, and one in another project than the caller names.
 */
export async function readReportRun(args: {
  runId: string;
  userId: string;
  agency: ActorAgency;
  projectId?: string;
  now?: Date;
}): Promise<ReportRun> {
  const stored = await storedRun(args.runId);
  if (!stored || (args.projectId !== undefined && stored.run.projectId !== args.projectId)) {
    throw refuse(
      'REPORT_RUN_NOT_FOUND',
      `no report run ${args.runId} is kept${args.projectId ? ` in project ${args.projectId}` : ''}: it was never stored, or it passed its ${REPORT_RUN_KEEP_DAYS}-day keep and was swept. Run the query again`,
      '/runId',
    );
  }
  const refusal = runReadRefusal(stored, args.userId, args.now ?? new Date());
  if (refusal) throw refusal;
  const access = await loadProjectAccess(stored.run.projectId, args.userId);
  requireHeld(access, stored.permission as ProjectPermission, `read report run ${args.runId}`);
  return stored.run;
}

/**
 * The frames of the kept runs of `projectId` among `runIds`, for the reply check that holds a chat
 * figure to a run. An id naming no kept run of this project is passed over, not refused: the ids are
 * read out of a turn's tool results, which name issues and sessions as well.
 */
export async function keptRunFrames(
  projectId: string,
  runIds: readonly string[],
  tx: Tx = db,
  now: Date = new Date(),
): Promise<ReportFrame[]> {
  const ids = [...new Set(runIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ frame: reportRuns.frame })
    .from(reportRuns)
    .where(
      and(
        inArray(reportRuns.id, ids),
        eq(reportRuns.projectId, projectId),
        gt(reportRuns.expiresAt, now),
      ),
    );
  return rows.map((r) => r.frame as ReportFrame);
}
