import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { type RunJournalRow, runJournal } from '../db/schema-journal.js';
import { resolveIssueKeyInProject } from '../issues/issue-route-ref.js';
import { assertProjectAccess } from '../lib/authz.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { issueJournalSchema, readIssueJournal } from './run-journal-routes-reference.js';
import { loadRunLivenessByRunIds, type RunLiveness } from './runs-liveness.js';
import { RUN_LIMIT, runsOfIssue } from './runs-of-issue.js';
import { loadCostByRunIds } from './runs-rollup.js';

const querySchema = z.object({
  projectId: z.uuid(),
  issueId: z.string().trim().min(1).max(200),
});

type IssueJournal = z.infer<typeof issueJournalSchema>;
type Attempt = IssueJournal['runs'][number]['attempts'][number];
type RunKind = IssueJournal['runs'][number]['kind'];
type RunStatus = IssueJournal['runs'][number]['status'];

/** A run of the issue as the read selects it: its own, or a group run the issue was opened in. */
export interface JournalRunHead {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  /** 1 for the issue's first run, counted over every run of the issue and not the page read. */
  ordinal: number;
  /** The issue keys a group run was opened over; null for a run of this issue alone. */
  group: string[] | null;
  /** A run session names no issue of its own, so this is how its issues reach it once it ends. */
  sessionId: string | null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * An attempt only its handoff recorded was written closed at the handoff's own instant, so its
 * start and end are one moment and say nothing about how long the step took: no span, not zero.
 */
function spanOf(row: RunJournalRow): number | null {
  if (!row.endedAt) return null;
  const handoffOnly =
    row.handoffAt !== null &&
    row.startedAt.getTime() === row.handoffAt.getTime() &&
    row.endedAt.getTime() === row.handoffAt.getTime();
  return handoffOnly ? null : (row.endedAt.getTime() - row.startedAt.getTime()) / 1000;
}

function toAttempt(row: RunJournalRow): Attempt {
  return {
    phase: row.phase,
    attempt: row.attempt,
    source: row.source,
    outcome: row.outcome,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: spanOf(row),
    artifact: asObject(row.artifact),
    handoff: asObject(row.handoff),
    handoffAt: row.handoffAt,
  };
}

/**
 * An issue's runs, newest first, each holding the attempts the journal recorded for this issue in
 * the order they started. A run of the issue alone holds every attempt it recorded; a group run
 * holds only those naming this issue, since an attempt naming none there may be another member's.
 * A run that recorded nothing is still a run of the issue and answers empty.
 */
export function groupByRun(
  runs: readonly JournalRunHead[],
  rows: readonly RunJournalRow[],
  issueId: string,
  costs: ReadonlyMap<string, number> = new Map(),
  live: ReadonlyMap<string, RunLiveness> = new Map(),
): IssueJournal {
  const grouped = new Set(runs.filter((r) => r.group !== null).map((r) => r.id));
  const attempts = new Map<string, Attempt[]>();
  for (const row of rows) {
    if (grouped.has(row.runId) && row.issueId !== issueId) continue;
    const list = attempts.get(row.runId) ?? [];
    list.push(toAttempt(row));
    attempts.set(row.runId, list);
  }
  const out = runs.map((run) => ({
    runId: run.id,
    ordinal: run.ordinal,
    kind: run.kind,
    status: run.status,
    group: run.group,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: costs.get(run.id) ?? null,
    sessionId: run.sessionId,
    // The run's word comes from the read every run surface takes it from, never from its status.
    reading: live.get(run.id)?.reading ?? null,
    hold: live.get(run.id)?.hold ?? null,
    block: live.get(run.id)?.block ?? null,
    runningSince: live.get(run.id)?.runningSince ?? null,
    attempts: (attempts.get(run.id) ?? []).sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.attempt - b.attempt,
    ),
  }));
  out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.ordinal - a.ordinal);
  return { runs: out };
}

const asDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

export const runJournalRoutes = new Hono<{ Variables: AuthVars }>();
runJournalRoutes.use('*', requireAuth(), assertEmailVerified());

runJournalRoutes.get(
  '/',
  readIssueJournal,
  zValidator('query', querySchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const q = c.req.valid('query');
    await assertProjectAccess(q.projectId, c.get('userId'), 'viewer', 'read its run journal');
    const issueId = await resolveIssueKeyInProject(q.issueId, q.projectId);
    const [issue] = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.projectId, q.projectId)));
    const key = issue?.issSeq ? canonicalIssueKey(issue.issSeq) : '';
    const every = await runsOfIssue(q.projectId, issueId, key);
    const heads: JournalRunHead[] = every
      .map((r, i) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        startedAt: asDate(r.started_at),
        finishedAt: r.finished_at === null ? null : asDate(r.finished_at),
        ordinal: i + 1,
        group: r.grp,
        sessionId: r.session_id,
      }))
      .slice(-RUN_LIMIT);
    const runIds = heads.map((r) => r.id);
    const [rows, costs, live] = await Promise.all([
      runIds.length === 0
        ? Promise.resolve([] as RunJournalRow[])
        : db.select().from(runJournal).where(inArray(runJournal.runId, runIds)),
      loadCostByRunIds(runIds),
      loadRunLivenessByRunIds(runIds),
    ]);
    const cost = new Map([...costs].map(([runId, c]) => [runId, c.estimatedCost]));
    return c.json(answer(issueJournalSchema, groupByRun(heads, rows, issueId, cost, live)));
  },
);
