// The cleanup ledger's rows (REQ-79): this module is the only writer of `change_impacts`,
// `delivery_debts` and `cleanup_reports`. Pure decisions are `rules.ts`'.

import type {
  CleanupReportRequest,
  CleanupReportView,
  DebtItem,
  DebtView,
  Impact,
  ImpactView,
} from '@forge/contracts/cleanup';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { changeImpacts, cleanupReports, deliveryDebts } from '../db/schema-cleanup.js';
import { issueDisplayIds } from '../issues/index.js';
import type { LastReport, OpenDebt, RatedIssue } from './rules.js';

export async function insertImpact(
  tx: Tx,
  row: {
    projectId: string;
    issueId: string;
    impact: Impact;
    commit: string | null;
    ratedBy: string | null;
  },
): Promise<ImpactView> {
  const [r] = await tx
    .insert(changeImpacts)
    .values({
      projectId: row.projectId,
      issueId: row.issueId,
      type: row.impact.type,
      rating: row.impact.rating,
      reason: row.impact.reason,
      commitSha: row.commit,
      ratedBy: row.ratedBy,
    })
    .returning();
  if (!r) throw new Error('change_impacts: insert returned no row');
  return impactView(r);
}

function impactView(r: typeof changeImpacts.$inferSelect): ImpactView {
  return {
    id: r.id,
    issueId: r.issueId,
    type: r.type,
    rating: r.rating,
    reason: r.reason,
    commit: r.commitSha,
    ratedBy: r.ratedBy,
    ratedAt: r.createdAt.toISOString(),
  };
}

/** Every rating of an issue, newest first: the first is its current one. */
export async function issueImpacts(issueId: string): Promise<ImpactView[]> {
  const rows = await db
    .select()
    .from(changeImpacts)
    .where(eq(changeImpacts.issueId, issueId))
    .orderBy(desc(changeImpacts.createdAt), desc(changeImpacts.id));
  return rows.map(impactView);
}

export async function insertDebts(
  tx: Tx,
  rows: {
    projectId: string;
    issueId: string | null;
    items: readonly DebtItem[];
    recordedBy: string | null;
  },
): Promise<string[]> {
  if (rows.items.length === 0) return [];
  const written = await tx
    .insert(deliveryDebts)
    .values(
      rows.items.map((d) => ({
        projectId: rows.projectId,
        issueId: rows.issueId,
        kind: d.kind,
        checkName: d.check ?? null,
        location: d.where,
        detail: d.detail,
        impactType: d.impact.type,
        impactRating: d.impact.rating,
        impactReason: d.impact.reason,
        recordedBy: rows.recordedBy,
      })),
    )
    .returning({ id: deliveryDebts.id });
  return written.map((w) => w.id);
}

/** The project's open debt, oldest first, for a report to be checked against. */
export async function openDebts(
  executor: Pick<Tx, 'select'>,
  projectId: string,
): Promise<OpenDebt[]> {
  const rows = await executor
    .select({
      id: deliveryDebts.id,
      where: deliveryDebts.location,
      rating: deliveryDebts.impactRating,
    })
    .from(deliveryDebts)
    .where(and(eq(deliveryDebts.projectId, projectId), isNull(deliveryDebts.clearedAt)))
    .orderBy(asc(deliveryDebts.createdAt));
  return rows;
}

/** The project's debts, open or cleared, newest first, at most `limit` of each. */
export async function readDebts(
  projectId: string,
  limit = 200,
): Promise<{ open: DebtView[]; cleared: DebtView[] }> {
  const read = (cleared: boolean) =>
    db
      .select()
      .from(deliveryDebts)
      .where(
        and(
          eq(deliveryDebts.projectId, projectId),
          cleared ? isNotNull(deliveryDebts.clearedAt) : isNull(deliveryDebts.clearedAt),
        ),
      )
      .orderBy(desc(deliveryDebts.createdAt))
      .limit(limit);
  const [open, cleared] = await Promise.all([read(false), read(true)]);
  const ids = [...open, ...cleared].flatMap((r) => (r.issueId ? [r.issueId] : []));
  const keys = ids.length ? await issueDisplayIds([...new Set(ids)]) : new Map<string, string>();
  const view = (r: typeof deliveryDebts.$inferSelect): DebtView => ({
    id: r.id,
    issueId: r.issueId,
    issueKey: r.issueId ? (keys.get(r.issueId) ?? null) : null,
    kind: r.kind,
    check: r.checkName,
    where: r.location,
    detail: r.detail,
    impact: { type: r.impactType, rating: r.impactRating, reason: r.impactReason },
    recordedBy: r.recordedBy,
    recordedAt: r.createdAt.toISOString(),
    cleared:
      r.clearedAt && r.clearedHow
        ? { reportId: r.clearedReportId ?? '', how: r.clearedHow, at: r.clearedAt.toISOString() }
        : null,
  });
  return { open: open.map(view), cleared: cleared.map(view) };
}

/** Each issue's current rating, among `issueIds`. */
export async function currentRatings(issueIds: readonly string[]): Promise<RatedIssue[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .selectDistinctOn([changeImpacts.issueId], {
      issueId: changeImpacts.issueId,
      type: changeImpacts.type,
      rating: changeImpacts.rating,
      reason: changeImpacts.reason,
      ratedAt: changeImpacts.createdAt,
    })
    .from(changeImpacts)
    .where(inArray(changeImpacts.issueId, [...issueIds]))
    .orderBy(changeImpacts.issueId, desc(changeImpacts.createdAt), desc(changeImpacts.id));
  return rows.map((r) => ({
    issueId: r.issueId,
    impact: { type: r.type, rating: r.rating, reason: r.reason },
    ratedAt: r.ratedAt,
  }));
}

/**
 * The project's open issues that carry a rating at all, with their status; `unlanded` leaves out
 * those whose merge is marked (where production deploys on land, a landed change is live).
 */
export async function ratedOpenIssues(
  projectId: string,
  unlanded = false,
): Promise<{ id: string; status: string }[]> {
  return db
    .selectDistinct({ id: issues.id, status: issues.status })
    .from(issues)
    .innerJoin(changeImpacts, eq(changeImpacts.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        notInArray(issues.status, [...ISSUE_TERMINAL_STATUSES]),
        unlanded ? isNull(issues.mergedAt) : undefined,
      ),
    );
}

/** When a green cleanup report last covered each issue, among `issueIds`. */
export async function greenCoverage(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT c.issue_id, max(r.created_at) AS at
      FROM ${cleanupReports} r,
           jsonb_array_elements_text(r.covers) AS c(issue_id)
     WHERE r.project_id = ${projectId}
       AND r.result = 'green'
       AND c.issue_id IN (${sql.join(
         issueIds.map((id) => sql`${id}`),
         sql`, `,
       )})
     GROUP BY c.issue_id`)) as unknown as { issue_id: string; at: string | Date }[];
  return new Map(rows.map((r) => [r.issue_id, new Date(r.at)]));
}

export async function insertReport(
  tx: Tx,
  row: {
    projectId: string;
    report: CleanupReportRequest;
    covers: readonly string[];
    reportedBy: string | null;
  },
): Promise<typeof cleanupReports.$inferSelect> {
  const { report } = row;
  const [r] = await tx
    .insert(cleanupReports)
    .values({
      projectId: row.projectId,
      scheduleRunId: report.fire ?? null,
      branch: report.base.branch,
      headSha: report.base.sha.toLowerCase(),
      result: report.result,
      ci: report.ci ?? null,
      cleared: report.cleared,
      remains: report.remains,
      covers: [...row.covers],
      reportedBy: row.reportedBy,
    })
    .returning();
  if (!r) throw new Error('cleanup_reports: insert returned no row');
  const at = new Date();
  for (const c of report.cleared) {
    await tx
      .update(deliveryDebts)
      .set({ clearedReportId: r.id, clearedHow: c.how, clearedAt: at })
      .where(
        and(
          eq(deliveryDebts.id, c.debt),
          eq(deliveryDebts.projectId, row.projectId),
          isNull(deliveryDebts.clearedAt),
        ),
      );
  }
  return r;
}

export async function readReports(projectId: string, limit = 50): Promise<CleanupReportView[]> {
  const rows = await db
    .select()
    .from(cleanupReports)
    .where(eq(cleanupReports.projectId, projectId))
    .orderBy(desc(cleanupReports.createdAt))
    .limit(limit);
  const covered = rows.flatMap((r) => r.covers as string[]);
  const keys = covered.length ? await issueDisplayIds([...new Set(covered)]) : new Map();
  return rows.map((r) => reportView(r, keys));
}

export function reportView(
  r: typeof cleanupReports.$inferSelect,
  keys: ReadonlyMap<string, string>,
): CleanupReportView {
  return {
    id: r.id,
    fireId: r.scheduleRunId,
    base: { branch: r.branch, sha: r.headSha },
    result: r.result,
    ci: r.ci,
    cleared: r.cleared as CleanupReportView['cleared'],
    remains: r.remains as CleanupReportView['remains'],
    covers: (r.covers as string[]).map((issueId) => ({
      issueId,
      issueKey: keys.get(issueId) ?? issueId,
    })),
    reportedBy: r.reportedBy,
    reportedAt: r.createdAt.toISOString(),
  };
}

/** The project's newest cleanup report on `branch`, or null where none was filed on it. */
export async function lastReport(
  executor: Pick<Tx, 'select'>,
  projectId: string,
  branch: string,
): Promise<LastReport | null> {
  const [r] = await executor
    .select({
      id: cleanupReports.id,
      result: cleanupReports.result,
      branch: cleanupReports.branch,
      sha: cleanupReports.headSha,
      reportedAt: cleanupReports.createdAt,
    })
    .from(cleanupReports)
    .where(and(eq(cleanupReports.projectId, projectId), eq(cleanupReports.branch, branch)))
    .orderBy(desc(cleanupReports.createdAt), desc(cleanupReports.id))
    .limit(1);
  return r ?? null;
}

/** When the newest change currently rated high, other than `exceptIssueId`, was marked landed. */
export async function lastHighLanding(
  projectId: string,
  exceptIssueId: string,
): Promise<Date | null> {
  const rows = (await db.execute(sql`
    SELECT max(i.merged_at) AS at
      FROM ${issues} i
      JOIN LATERAL (
        SELECT c.rating FROM ${changeImpacts} c
         WHERE c.issue_id = i.id
         ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      ) r ON true
     WHERE i.project_id = ${projectId} AND i.id <> ${exceptIssueId}
       AND i.merged_at IS NOT NULL AND r.rating = 'high'`)) as unknown as {
    at: string | Date | null;
  }[];
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}
