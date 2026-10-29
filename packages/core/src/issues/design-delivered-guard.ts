// The delivery a design-only issue closes on (REQ-45 BC-4): its merge mark names design revisions
// alone and every one it drew is approved. Read by the `released` and `design_delivered` guards, and
// by `fail_routed` on the edge from `reopen` to `closed`, which a design-only issue closes along too.

import { sql } from 'drizzle-orm';
import { designHeldSql, designHoldsOf, designOnlyMarkSql } from './design-delivery.js';
import { quote } from './transition-faults.js';
import type { GuardContext, GuardFault } from './transition-guards.js';

export interface DesignDelivery {
  /** The merge mark names design artifacts and nothing else: no commit, no paths. */
  designOnly: boolean;
  /** The design revisions the mark names. */
  marked: string[];
  /** `<flow> rev <n>` of every revision this issue drew that was approved. */
  approved: string[];
  /** `<flow> rev <n>` of every revision it delivers that is not approved yet. */
  unapproved: string[];
}

export async function readDesignDelivery(ctx: GuardContext): Promise<DesignDelivery> {
  const rows = (await ctx.executor.execute(sql`
    SELECT ${designOnlyMarkSql(sql`i`)} AS design_only,
           coalesce((SELECT array_agg(a->>'ref') FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(i.merged_artifacts) = 'array' THEN i.merged_artifacts ELSE '[]'::jsonb END) a),
                    '{}') AS marked,
           coalesce((SELECT array_agg(DISTINCT w.flow || ' rev ' || d.revision)
                       FROM project_workflow_designs d JOIN project_workflows w ON w.id = d.workflow_id
                      WHERE d.design_issue_id = i.id AND d.decision = 'approve'), '{}') AS approved,
           ${designHeldSql(sql`i.id`)} AS held
      FROM issues i WHERE i.id = ${ctx.issue.id}
  `)) as unknown as Array<{
    design_only: boolean;
    marked: string[];
    approved: string[];
    held: boolean;
  }>;
  const row = rows[0];
  if (!row) return { designOnly: false, marked: [], approved: [], unapproved: [] };
  const unapproved = row.held
    ? ((await designHoldsOf(ctx.executor, [ctx.issue.id])).get(ctx.issue.id) ?? []).map(
        (h) => `${h.flow} rev ${h.revision}`,
      )
    : [];
  return {
    designOnly: row.design_only === true,
    marked: row.marked,
    approved: row.approved,
    unapproved,
  };
}

export function designShortfall(d: DesignDelivery): string {
  if (d.unapproved.length > 0) return `design ${d.unapproved.join(', ')} is not approved yet`;
  return 'no design revision it drew is approved';
}

/** closed from a live status: the issue is design-only and every revision it delivers is approved. */
export async function designDeliveredGuard(ctx: GuardContext): Promise<GuardFault | null> {
  const d = await readDesignDelivery(ctx);
  if (d.designOnly && d.unapproved.length === 0 && d.approved.length > 0) return null;
  const why = d.designOnly
    ? designShortfall(d)
    : 'its merge mark does not name design revisions alone (a commit, read paths, or a non-design artifact is on it, or there is no mark), so its work ships through a release';
  return {
    code: 'DESIGN_NOT_DELIVERED',
    detail: `${quote(ctx.from)} → \`closed\` is the close of an issue whose only deliverable is a design, once its design revisions are approved, and ${why}. An issue that ships code moves to \`awaiting_release\` and closes through its release.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      designOnly: d.designOnly,
      marked: d.marked,
      approved: d.approved,
      unapproved: d.unapproved,
    },
  };
}
