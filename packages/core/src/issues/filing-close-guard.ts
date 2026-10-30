// The `filing_released` guard, on the edge from `draft` to `closed` (issue-lifecycle revision 24,
// ISS-774). A draft filed for a merge its project owed a filing for answers code that landed before
// it was filed, often code a release already shipped: it closes on that release, once the agent's
// shipped-in record has claimed it onto it (`release-batch/shipped-in.ts:recordShippedIn`), never
// through `open`, which would dispatch a run for work already done. A design-only draft closes along
// this edge on its approved design, as from any other live status.

import { sql } from 'drizzle-orm';
import { designDeliveredGuard, readDesignDelivery } from './design-delivered-guard.js';
import type { OwedFiling } from './owed-merges.js';
import type { GuardContext, GuardFault } from './transition-guards.js';

/** `filing` is the owed filing the issue answers, read before the move (`filingAnsweredBy`). */
export async function filingReleasedGuard(
  ctx: GuardContext,
  filing: OwedFiling | null,
): Promise<GuardFault | null> {
  if ((await readDesignDelivery(ctx)).designOnly) return designDeliveredGuard(ctx);
  const shipped = `POST /api/projects/${ctx.issue.projectId}/shipped-in-records { issueId, version, evidence }`;
  if (!filing) {
    const design = await designDeliveredGuard(ctx);
    if (!design) return null;
    return {
      ...design,
      detail: `${design.detail} A draft closes on a release only where its observed landing is a merge its project owed a filing for, which no other issue answers (${shipped}).`,
    };
  }
  const rows = (await ctx.executor.execute(
    sql`SELECT release_batch_run_id FROM issues WHERE id = ${ctx.issue.id}`,
  )) as unknown as Array<{ release_batch_run_id: string | null }>;
  if (rows[0]?.release_batch_run_id) return null;
  return {
    code: 'CLOSE_ONLY_BY_RELEASE',
    detail: `this draft answers the filing its project owed for change request ${filing.number} at ${filing.commit}, so it closes on the release that shipped that merge, and no release has claimed it. Record that release: ${shipped}, naming the shipped release whose commit contains ${filing.commit}.`,
    details: { from: ctx.from, to: ctx.to, filing: filing.number, commit: filing.commit },
  };
}
