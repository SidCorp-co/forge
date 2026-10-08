// The executions `reports` keeps: each run of a script by a sandbox executor, stored with who asked,
// the turn it counted against, the script and its fingerprint, the runs and Forge paths it read, and what came back,
// for EXECUTION_KEEP_DAYS. A block drawn from one names it, and both doors read it back through
// `readExecution` alike.

import { createHash } from 'node:crypto';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  EXECUTION_KEEP_DAYS,
  type ExecutionLanguage,
  type ExecutionLimit,
  type ExecutionRecord,
  normalizeScript,
} from '@forge/contracts/report-executions';
import type { ReportFrame } from '@forge/contracts/report-queries';
import type { ScriptRead } from '@forge/contracts/script-sandbox';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { reportExecutions } from '../db/schema-report-executions.js';
import { loadProjectAccess } from '../lib/authz.js';
import { requireHeld } from '../permissions/index.js';
import { refuseExecution } from './executors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sha256 of the normalized script: the same computation asked again, however it was spaced. */
export function scriptFingerprint(script: string): string {
  return createHash('sha256').update(normalizeScript(script), 'utf8').digest('hex');
}

/** What one execution stores; its id is core's, never the adapter's. */
export interface ExecutionRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  turnKey: string;
  askedBy: string;
  askedAgency: ActorAgency;
  adapter: string;
  adapterExecutionId: string | null;
  language: ExecutionLanguage;
  script: string;
  inputRunIds: string[];
  limits: Record<ExecutionLimit, number>;
  exit: number;
  stopped: ExecutionLimit | null;
  durationMs: number;
  outputBytes: number;
  frames: ReportFrame[];
  logs: { stdout: string; stderr: string };
  error: { name: string; message: string } | null;
  /** Every read the script made of Forge, with its status (REQ-37 BC-9). */
  reads: ScriptRead[];
  createdAt: Date;
}

/** Stores one execution; it is kept EXECUTION_KEEP_DAYS from when it ran. */
export async function recordExecution(row: ExecutionRow): Promise<ExecutionRecord> {
  const expiresAt = new Date(row.createdAt.getTime() + EXECUTION_KEEP_DAYS * DAY_MS);
  const fingerprint = scriptFingerprint(row.script);
  await db.insert(reportExecutions).values({
    ...row,
    scriptFingerprint: fingerprint,
    expiresAt,
  });
  return recordOf({ ...row, scriptFingerprint: fingerprint, expiresAt });
}

type Stored = typeof reportExecutions.$inferSelect;

function recordOf(
  row: Omit<Stored, 'turnKey' | 'askedAgency' | 'adapterExecutionId' | 'outputBytes'>,
): ExecutionRecord {
  return {
    executionId: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    askedBy: row.askedBy,
    adapter: row.adapter,
    language: row.language,
    script: row.script,
    scriptFingerprint: row.scriptFingerprint,
    inputRunIds: row.inputRunIds,
    limits: row.limits as ExecutionRecord['limits'],
    exit: row.exit,
    stopped: row.stopped ?? null,
    durationMs: row.durationMs,
    frames: row.frames as ReportFrame[],
    logs: row.logs as ExecutionRecord['logs'],
    error: (row.error as ExecutionRecord['error']) ?? null,
    reads: row.reads as ScriptRead[],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * One kept execution, read back by the person who asked it, who must still read the project.
 * Refused by name: an execution never stored or already swept, one in another project than the
 * caller names, one asked by somebody else (its frames are what THEY may see), one past its keep.
 */
export async function readExecution(args: {
  executionId: string;
  userId: string;
  agency: ActorAgency;
  projectId?: string;
  now?: Date;
}): Promise<ExecutionRecord> {
  const [row] = UUID_RE.test(args.executionId)
    ? await db
        .select()
        .from(reportExecutions)
        .where(eq(reportExecutions.id, args.executionId))
        .limit(1)
    : [];
  if (!row || (args.projectId !== undefined && row.projectId !== args.projectId)) {
    throw refuseExecution(
      'EXECUTION_NOT_FOUND',
      `no execution ${args.executionId} is kept${args.projectId ? ` in project ${args.projectId}` : ''}: it never ran, or it passed its ${EXECUTION_KEEP_DAYS}-day keep and was swept. Run the computation again`,
      '/executionId',
    );
  }
  if (row.askedBy !== args.userId) {
    throw refuseExecution(
      'EXECUTION_READ_FORBIDDEN',
      `execution ${row.id} was asked by another member, over the runs they may read; only the person who asked it may read or show it. Run the computation yourself`,
      '/executionId',
    );
  }
  const now = args.now ?? new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw refuseExecution(
      'EXECUTION_EXPIRED',
      `execution ${row.id} (ran ${row.createdAt.toISOString()}) is gone: an execution is kept ${EXECUTION_KEEP_DAYS} days and this one expired at ${row.expiresAt.toISOString()}. Run the computation again`,
      '/executionId',
    );
  }
  const access = await loadProjectAccess(row.projectId, args.userId);
  requireHeld(access, 'project.read', `read execution ${row.id}`);
  return recordOf(row);
}

/** What a turn has already spent on executions since `since`. */
export async function turnSpend(
  turnKey: string,
  since: Date,
): Promise<{ calls: number; wallMs: number; outputBytes: number }> {
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      wallMs: sql<number>`coalesce(sum(${reportExecutions.durationMs}), 0)::float8`,
      outputBytes: sql<number>`coalesce(sum(${reportExecutions.outputBytes}), 0)::int`,
    })
    .from(reportExecutions)
    .where(and(eq(reportExecutions.turnKey, turnKey), gt(reportExecutions.createdAt, since)));
  return {
    calls: Number(row?.calls ?? 0),
    wallMs: Number(row?.wallMs ?? 0),
    outputBytes: Number(row?.outputBytes ?? 0),
  };
}

/**
 * The frames of the kept executions of `projectId` among `ids`, for the reply check that holds a
 * chat figure to a read: an execution's frames ground a figure as a run's do. An id naming no kept
 * execution of this project is passed over, not refused: the ids are read out of a turn's tool
 * results, which name runs, issues and sessions as well.
 */
export async function keptExecutionFrames(
  projectId: string,
  ids: readonly string[],
  tx: Tx = db,
  now: Date = new Date(),
): Promise<ReportFrame[]> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select({ frames: reportExecutions.frames })
    .from(reportExecutions)
    .where(
      and(
        inArray(reportExecutions.id, wanted),
        eq(reportExecutions.projectId, projectId),
        gt(reportExecutions.expiresAt, now),
      ),
    );
  return rows.flatMap((r) => r.frames as ReportFrame[]);
}
