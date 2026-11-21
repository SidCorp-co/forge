// A release closes what it claimed (`close-in-scope.ts:inScopeGuard`), answering its own criteria
// hold, and that answer is false where a live criterion's newest verdict is a fail (ISS-1397, FB-806:
// adminhub-api 0.31.0 closed ISS-256 over criterion 3's fail). Such an issue is not closed by the
// release: it stays at `awaiting_release`, the release names it among those it could not close, and
// the refusal says the way on. An open criterion, with no verdict yet, is the normal state at a
// release (judged after it ships, REQ-45 BC-2) and closes as before. A fail recorded at or before the
// issue's latest reopen judged the build that reopen rejected (`release-evidence.ts:voidedUpTo`), so it
// holds nothing back from the release that ships the fix.

import type { Tx } from '../db/client.js';
import { type CriterionWithVerdict, listCriteria } from './criteria/store.js';
import { reopenedAtOf } from './release-evidence.js';
import type { GuardContext, GuardFault } from './transition-guards.js';

/** The live criteria whose newest verdict is a fail this round: not voided by a later reopen. */
export async function failingThisRound(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriterionWithVerdict[]> {
  const live = await listCriteria(executor, issueId);
  const failing = live.filter((c) => c.latest?.verdict === 'fail');
  if (failing.length === 0) return [];
  const reopenedAt = (await reopenedAtOf(executor, [issueId])).get(issueId)?.getTime();
  return failing.filter(
    (c) => reopenedAt === undefined || new Date(c.latest?.createdAt ?? 0).getTime() > reopenedAt,
  );
}

/** Where a failing verdict was judged, as the refusal names it; null where it names nothing. */
function judgedOn(c: CriterionWithVerdict): string | null {
  const v = c.latest;
  if (!v) return null;
  if (v.releaseVersion) return `release ${v.releaseVersion}`;
  if (v.commitSha) return `\`${v.commitSha.slice(0, 12)}\``;
  if (v.runtimeRef) return `runtime \`${v.runtimeRef}\``;
  return null;
}

/**
 * The refusal of a release's close over a live criterion failing this round: each one named, the
 * issue left at `awaiting_release`, and the two ways on, `destinations` naming where `unmet` may send
 * one (`close-in-scope.ts:UNMET_DESTINATIONS`).
 */
export async function releaseCloseFailing(
  ctx: GuardContext,
  destinations: string,
): Promise<GuardFault | null> {
  const failing = await failingThisRound(ctx.executor, ctx.issue.id);
  if (failing.length === 0) return null;
  const named = failing.map((c) => {
    const on = judgedOn(c);
    return `criterion ${c.n}'s newest verdict is a fail${on ? ` (judged on ${on})` : ''}`;
  });
  const each = failing.length === 1 ? 'it' : 'each';
  return {
    code: 'CLOSE_CRITERION_UNPLACED',
    detail: `a release closes an issue it claimed only where no live criterion fails, and ${named.join('; ')}: this release does not close it, and it waits at \`awaiting_release\`. The way on: move ${each} out on the record, closing it from \`awaiting_release\` as the run holding it (or a holder of \`releases.approve\` or \`project.admin\`) with \`unmet\` naming where ${each} goes: ${destinations}; or fix it and judge ${each} again to a pass, then record it against this release's version (\`POST /api/projects/${ctx.issue.projectId}/release-records\`) to close it there.`,
    details: {
      from: ctx.from,
      to: ctx.to,
      unplaced: failing.map((c) => ({
        criterion: c.n,
        why: 'its newest verdict is a fail, and a release moves no criterion out',
      })),
      destinations: ['next_batch_issue', 'new_issue', 'requirement'],
      byRelease: true,
    },
  };
}
