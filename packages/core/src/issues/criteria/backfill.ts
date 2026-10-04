/**
 * ISS-55 — the one-time read of the criteria and verdicts already held as text into
 * `issue_criteria` / `criterion_verdicts`, run by `db/migrate.ts` once
 * (`backfill_markers`), in one transaction. What `backfill-plan.ts` cannot represent is printed by
 * name in the deploy log, one line per refusal, and counted; the run never drops a row silently.
 *
 * Sources: every comment carrying a `forge-record` fence (the legacy and the mirrored alike — a
 * mirrored event is the same record as its comment, so it is not read twice), and every
 * `record.verdict` event written straight to `POST /api/issues/:id/events` (no comment behind it).
 */

import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../../db/backfill-markers.js';
import { db, type Tx } from '../../db/client.js';
import { criterionVerdicts, issueCriteria } from '../../db/schema-issue-criteria.js';
import { parseForgeRecord } from '../../messaging/forge-record.js';
import type { ActorAgency } from '../actor-agency.js';
import { recordOfFields } from '../record-events/store.js';
import {
  type BackfillDesign,
  type BackfillRecord,
  type BackfillVerdict,
  planIssueBackfill,
} from './backfill-plan.js';

export const CRITERIA_BACKFILL_KEY = 'iss-55-issue-criteria-and-verdicts';

const WHOLE_SHA = /\b[0-9a-f]{40}\b/giu;

export interface CriteriaBackfillReport {
  issues: number;
  criteria: number;
  verdicts: number;
  commitUnresolved: number;
  refusals: string[];
}

type IssueRow = {
  id: string;
  project_id: string;
  status: string;
  acceptance_criteria: string | null;
  merged_commit_sha: string | null;
  head_sha: string | null;
};

type CommentRow = {
  id: string;
  issue_id: string;
  body: string;
  author_id: string;
  author_device_id: string | null;
  author_kind: string | null;
  created_at: Date | string;
};

type EventRow = {
  id: string;
  issue_id: string;
  actor_type: string;
  actor_id: string;
  actor_agency: ActorAgency | null;
  payload: { contract?: number; fields?: Array<{ key: string; value: string }> } | null;
  created_at: Date | string;
};

const rows = async <T>(tx: Tx, query: ReturnType<typeof sql>) => [
  ...((await tx.execute(query)) as unknown as T[]),
];

function groupBy<T extends { issue_id: string }>(list: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of list) out.set(row.issue_id, [...(out.get(row.issue_id) ?? []), row]);
  return out;
}

async function designsByProject(tx: Tx): Promise<Map<string, Map<string, BackfillDesign>>> {
  const list = await rows<{ id: string; project_id: string; flow: string; revisions: number[] }>(
    tx,
    sql`SELECT w.id, w.project_id, w.flow,
               array_remove(array_agg(DISTINCT d.revision) || w.revision, NULL) AS revisions
          FROM project_workflows w
          LEFT JOIN project_workflow_designs d ON d.workflow_id = w.id
         GROUP BY w.id`,
  );
  const out = new Map<string, Map<string, BackfillDesign>>();
  for (const w of list) {
    const held = out.get(w.project_id) ?? new Map<string, BackfillDesign>();
    const design = { id: w.id, revisions: w.revisions.map(Number) };
    held.set(w.flow, design);
    held.set(w.id, design);
    out.set(w.project_id, held);
  }
  return out;
}

function recordsOf(comments: readonly CommentRow[], events: readonly EventRow[]): BackfillRecord[] {
  const fromComments = comments.flatMap((c): BackfillRecord[] => {
    const record = parseForgeRecord(c.body);
    if (record?.kind !== 'verdict') return [];
    const agent = c.author_device_id !== null || c.author_kind === 'agent';
    return [
      {
        source: `comment ${c.id}`,
        commentId: c.id,
        record,
        author: {
          userId: c.author_id,
          deviceId: c.author_device_id,
          agency: agent ? 'agent' : 'human',
        },
        createdAt: new Date(c.created_at),
      },
    ];
  });
  const fromEvents = events.map(
    (e): BackfillRecord => ({
      source: `event ${e.id}`,
      commentId: null,
      record: recordOfFields('verdict', e.payload?.contract ?? 1, e.payload?.fields ?? []),
      author: {
        userId: e.actor_type === 'user' ? e.actor_id : null,
        deviceId: e.actor_type === 'device' ? e.actor_id : null,
        agency: e.actor_agency ?? (e.actor_type === 'device' ? 'agent' : 'human'),
      },
      createdAt: new Date(e.created_at),
    }),
  );
  return [...fromComments, ...fromEvents].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

async function insertPlan(
  tx: Tx,
  issueId: string,
  criteria: ReadonlyArray<{ n: number; statement: string }>,
  verdicts: readonly BackfillVerdict[],
): Promise<void> {
  if (criteria.length === 0) return;
  const inserted = await tx
    .insert(issueCriteria)
    .values(criteria.map((c, position) => ({ issueId, n: c.n, statement: c.statement, position })))
    .returning({ id: issueCriteria.id, n: issueCriteria.n });
  const idOf = new Map(inserted.map((row) => [row.n, row.id]));
  if (verdicts.length === 0) return;
  await tx.insert(criterionVerdicts).values(
    verdicts.map((v) => ({
      criterionId: idOf.get(v.n) as string,
      issueId,
      verdict: v.verdict as 'pass' | 'short' | 'fail' | 'skipped',
      reason: v.reason?.trim() || null,
      identityKind: v.identityKind,
      commitSha: v.commitSha,
      runtimeRef: v.runtimeRef,
      designWorkflowId: v.designWorkflowId,
      designRevision: v.designRevision,
      evidence: [...v.evidence],
      authorUserId: v.author.userId,
      authorDeviceId: v.author.deviceId,
      authorAgency: v.author.agency,
      commentId: v.commentId,
      backfilled: true,
      createdAt: v.createdAt,
    })),
  );
}

/** Read every issue's criteria and verdicts into the tables. One transaction; the plan decides. */
export async function backfillCriteria(tx: Tx): Promise<CriteriaBackfillReport> {
  const issueRows = await rows<IssueRow>(
    tx,
    sql`SELECT i.id, i.project_id, i.status, i.acceptance_criteria, i.merged_commit_sha, w.head_sha
          FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id
         WHERE NOT EXISTS (SELECT 1 FROM issue_criteria c WHERE c.issue_id = i.id)`,
  );
  const comments = groupBy(
    await rows<CommentRow>(
      tx,
      sql`SELECT c.id, c.issue_id, c.body, c.author_id, c.author_device_id, u.kind AS author_kind, c.created_at
            FROM comments c LEFT JOIN users u ON u.id = c.author_id
           WHERE c.body LIKE '%forge-record%' OR c.body ~ '[0-9a-f]{40}'
           ORDER BY c.created_at, c.id`,
    ),
  );
  const events = groupBy(
    await rows<EventRow>(
      tx,
      sql`SELECT id, issue_id, actor_type, actor_id, actor_agency, payload, created_at
            FROM activity_log
           WHERE action = 'record.verdict' AND issue_id IS NOT NULL AND NOT (payload ? 'commentId')
             AND payload->>'writer' IS DISTINCT FROM 'core'
           ORDER BY created_at, id`,
    ),
  );
  const designs = await designsByProject(tx);
  const report: CriteriaBackfillReport = {
    issues: 0,
    criteria: 0,
    verdicts: 0,
    commitUnresolved: 0,
    refusals: [],
  };
  for (const issue of issueRows) {
    const theirComments = comments.get(issue.id) ?? [];
    const theirEvents = events.get(issue.id) ?? [];
    if (
      !issue.acceptance_criteria?.trim() &&
      theirComments.length === 0 &&
      theirEvents.length === 0
    )
      continue;
    const knownShas = [
      issue.merged_commit_sha,
      issue.head_sha,
      ...theirComments.flatMap((c) => c.body.match(WHOLE_SHA) ?? []),
      ...theirEvents.flatMap((e) =>
        (e.payload?.fields ?? []).flatMap((f) => f.value.match(WHOLE_SHA) ?? []),
      ),
    ].filter((s): s is string => typeof s === 'string' && s.length === 40);
    const plan = planIssueBackfill(
      {
        id: issue.id,
        status: issue.status,
        acceptanceCriteria: issue.acceptance_criteria,
        knownShas,
      },
      recordsOf(theirComments, theirEvents),
      designs.get(issue.project_id) ?? new Map(),
    );
    await insertPlan(tx, issue.id, plan.criteria, plan.verdicts);
    if (plan.criteria.length > 0) report.issues += 1;
    report.criteria += plan.criteria.length;
    report.verdicts += plan.verdicts.length;
    report.commitUnresolved += plan.verdicts.filter(
      (v) => v.identityKind === 'commit_unresolved',
    ).length;
    report.refusals.push(...plan.refusals);
  }
  return report;
}

/** Run the backfill once per database; boot (`boot-backfills.ts`) logs the report, every refusal by name. */
export async function runCriteriaBackfillOnce(): Promise<CriteriaBackfillReport | null> {
  return db.transaction(async (tx) => {
    if (await backfillMarkedIn(tx, CRITERIA_BACKFILL_KEY)) return null;
    const done = await backfillCriteria(tx);
    await markBackfillIn(tx, CRITERIA_BACKFILL_KEY);
    return done;
  });
}
