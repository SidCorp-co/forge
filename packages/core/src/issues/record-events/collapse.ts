// Narration retention (ISS-56, decision Q6): once an issue has been terminal for 180 days, its
// narration events (fold, routed, gap, baseline) collapse into one `record.digest` row counting
// them by kind. Kernel evidence — verdicts, transitions, landings, parks, corrections — is never
// touched: the collapse set is `NARRATION_RECORD_KINDS`, typed so that it cannot name one.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import {
  KERNEL_RECORD_KINDS,
  NARRATION_COLLAPSE_DAYS,
  NARRATION_RECORD_KINDS,
  RECORD_ACTION_PREFIX,
  RECORD_DIGEST_KIND,
  recordAction,
} from '@forge/contracts/record-events';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { activityLog } from '../../db/schema-activity.js';

/** How many issues one pass collapses, so a first run over years of history is bounded. */
const ISSUES_PER_PASS = 500;

/**
 * The actions a collapse may delete, checked once more at run time: a kernel kind reaching this
 * list is a defect the type should already have refused, and it must stop the sweep, not delete.
 */
export function collapsibleActions(
  narration: readonly string[] = NARRATION_RECORD_KINDS,
): string[] {
  const kernel = new Set<string>(KERNEL_RECORD_KINDS);
  const named = narration.filter((kind) => kernel.has(kind));
  if (named.length > 0) {
    throw new Error(
      `narration collapse set names ${named.join(', ')}, which is kernel evidence and is kept for good — it may not be in the narration collapse set`,
    );
  }
  return narration.map((kind) => `${RECORD_ACTION_PREFIX}${kind}`);
}

export interface CollapseResult {
  readonly issues: number;
  readonly collapsed: number;
}

/**
 * When an issue became terminal, read conservatively: its newest audited move, or its last update
 * where the audit has been swept. Both are at or after the close, so nothing collapses early.
 */
const closedAt = sql`COALESCE(
  (SELECT max(kt.created_at) FROM kernel_transitions kt
    WHERE kt.entity = 'issue' AND kt.entity_id = ${issues.id}),
  ${issues.updatedAt}
)`;

/** Issues terminal since before `cutoff` that still hold narration. */
async function candidates(cutoff: Date, actions: string[], limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        inArray(issues.status, [...ISSUE_TERMINAL_STATUSES]),
        sql`${closedAt} < ${cutoff}`,
        sql`EXISTS (SELECT 1 FROM activity_log a WHERE a.issue_id = ${issues.id}
          AND a.action IN (${sql.join(
            actions.map((a) => sql`${a}`),
            sql`, `,
          )}))`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Collapse one issue's narration into its digest, in one transaction. Returns rows removed. */
async function collapseIssue(issueId: string, actions: string[]): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.issueId, issueId), inArray(activityLog.action, actions)))
      .orderBy(desc(activityLog.createdAt));
    const newest = rows[0];
    if (!newest) return 0;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const kind = row.action.slice(RECORD_ACTION_PREFIX.length);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    const digestAction = recordAction(RECORD_DIGEST_KIND);
    const [digest] = await tx
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.issueId, issueId), eq(activityLog.action, digestAction)))
      .limit(1);
    if (digest) {
      const held = ((digest.payload as { counts?: Record<string, number> }).counts ?? {}) as Record<
        string,
        number
      >;
      for (const [kind, n] of Object.entries(held)) counts[kind] = (counts[kind] ?? 0) + n;
      await tx
        .update(activityLog)
        .set({ payload: { contract: 1, fields: [], lead: null, counts } })
        .where(eq(activityLog.id, digest.id));
    } else {
      await tx.insert(activityLog).values({
        issueId,
        actorType: newest.actorType,
        actorId: newest.actorId,
        actorAgency: newest.actorAgency,
        action: digestAction,
        payload: { contract: 1, fields: [], lead: null, counts },
        createdAt: newest.createdAt,
      });
    }
    await tx
      .delete(activityLog)
      .where(and(eq(activityLog.issueId, issueId), inArray(activityLog.action, actions)));
    return rows.length;
  });
}

/** One retention pass over every issue whose narration is due to collapse. */
export async function collapseNarration(
  opts: { now?: Date; days?: number; limit?: number } = {},
): Promise<CollapseResult> {
  const actions = collapsibleActions();
  const days = opts.days ?? NARRATION_COLLAPSE_DAYS;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
  const ids = await candidates(cutoff, actions, opts.limit ?? ISSUES_PER_PASS);
  let collapsed = 0;
  for (const id of ids) collapsed += await collapseIssue(id, actions);
  return { issues: ids.length, collapsed };
}
